import type {
  SettingsHost,
  ThemeChoice,
  AgentPersona,
  SandboxPolicy,
  CliRuntime,
  ExportDestination,
  ExportFormat,
  CustomMcpServer,
  DiscoveredMcpServer,
  CliToolDefinition,
  InterfaceScope,
  WebRemoteBindingStatus,
  WebRemoteBindSelection,
  WebRemoteState,
  WebRemoteTlsMode,
  UpdateState,
} from "../app";
import { startSettings } from "./start";
import { initFontSetting } from "../font-setting";
import { isWebRemote } from "../transport-mode";
import { SETTINGS_HTML } from "./template";

export function mountSettings(host: SettingsHost) {
  host.settingsOverlay.innerHTML = SETTINGS_HTML;
  const modelSelect = document.getElementById("model-select") as HTMLSelectElement;
  document.getElementById("settings-close")!.addEventListener("click", host.closeSettings);
  host.settingsOverlay
    .querySelector(".settings-backdrop")!
    .addEventListener("click", host.hideSettings);
  const workspacePathEl = document.getElementById("workspace-path") as HTMLSpanElement;
  const workspaceBtn = document.getElementById("workspace-btn") as HTMLButtonElement;
  const workspaceClearBtn = document.getElementById("workspace-clear-btn") as HTMLButtonElement;
  function updateWorkspaceDisplay(path: string | null): void {
    const parts = path?.replace(/\\/g, "/").split("/");
    workspacePathEl.textContent = parts
      ? parts.length > 2
        ? "…/" + parts.slice(-2).join("/")
        : path
      : "Not set";
    workspacePathEl.title = path ?? "";
    workspacePathEl.classList.toggle("clickable", !!path);
    workspaceClearBtn.classList.toggle("hidden", !path);
  }
  workspaceBtn.addEventListener("click", async () => {
    const result = await host.whimAPI.selectWorkspace();
    if (result.selected) host.updateWorkspaceDisplay(result.path);
  });
  workspaceClearBtn.addEventListener("click", async () => {
    await host.whimAPI.clearWorkspace();
    host.updateWorkspaceDisplay(null);
  });
  workspacePathEl.addEventListener("click", () => {
    if (workspacePathEl.title) host.whimAPI.openPath(workspacePathEl.title);
  });
  updateWorkspaceDisplay(host.currentWorkspacePath);
  void initFontSetting(host.whimAPI, !isWebRemote()).catch((error) =>
    host.showStatus(error instanceof Error ? error.message : "Font setting could not load", true),
  );

  modelSelect.addEventListener("change", async () => {
    const model = modelSelect.value;
    if (model) {
      await host.whimAPI.setSetting("model", model);
      host.showStatus(`✓ Model set to ${model}`);
      setTimeout(host.hideStatus, 2000);
    }
  });

  async function loadModels(): Promise<void> {
    const currentModel = await host.whimAPI.getSetting("model");
    try {
      const models = await host.whimAPI.listModels();
      modelSelect.innerHTML = "";

      if (models.length === 0) {
        modelSelect.innerHTML = '<option value="">No models available</option>';
        return;
      }

      for (const m of models) {
        const opt = document.createElement("option");
        opt.value = m.id;
        opt.textContent = m.name || m.id;
        if (m.id === currentModel) opt.selected = true;
        modelSelect.appendChild(opt);
      }

      // If no saved model, select the first one
      if (!currentModel && models.length > 0) {
        modelSelect.value = models[0].id;
      }
    } catch {
      modelSelect.innerHTML = '<option value="">Failed to load models</option>';
    }
  }

  // ── Theme toggle (Settings → Appearance) ────────────────
  const themeToggle = document.getElementById("theme-toggle") as HTMLDivElement | null;
  const themeToggleBtns = themeToggle
    ? Array.from(themeToggle.querySelectorAll<HTMLButtonElement>(".theme-btn"))
    : [];

  /** Reflect the active choice in the segmented control's button states. */
  function syncThemeControl(choice: ThemeChoice): void {
    for (const btn of themeToggleBtns) {
      const active = btn.dataset.theme === choice;
      btn.classList.toggle("active", active);
      btn.setAttribute("aria-checked", String(active));
    }
  }

  for (const btn of themeToggleBtns) {
    btn.addEventListener("click", async () => {
      const choice = host.normalizeChoice(btn.dataset.theme);
      host.applyTheme(choice);
      syncThemeControl(choice);
      await host.whimAPI.setSetting("theme", choice);
      // Broadcast so any open canvas / settings popout windows update live.
      host.whimAPI.notifyCanvasThemeChanged(choice);
    });
  }

  async function loadWorkspaceSetting(): Promise<void> {
    const ws = await host.whimAPI.getSetting("workspace_root");
    host.updateWorkspaceDisplay(ws);
  }

  // ── Agent Personas ──────────────────────────────────────
  const agentsSelectionList = document.getElementById("agents-selection-list") as HTMLDivElement;
  const agentsEditor = document.getElementById("agents-editor") as HTMLDivElement;
  const personaAddBtn = document.getElementById("persona-add-btn") as HTMLButtonElement;
  let personaModels: { id: string; name?: string }[] = [];
  let selectedAgentId: string | null = null;

  const HANDLE_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

  async function loadPersonas(): Promise<void> {
    const generation = host.getWorkspaceGeneration();
    await host.loadPersonasSnapshot(host.bridgeApi, { force: true });
    host.personas = [...host.personaStore.getState().personas];
    try {
      personaModels = await host.whimAPI.listModels();
    } catch {
      personaModels = [];
    }
    if (generation !== host.getWorkspaceGeneration()) return;
    host.ensureDefaultAgent();
    host.personaStore.setPersonas(host.personas);
    renderAgentsSidebar();
    // Auto-select @agent if nothing selected
    if (!selectedAgentId) {
      const defaultAgent = host.personas.find((p) => p.handle === host.DEFAULT_AGENT_HANDLE);
      if (defaultAgent) selectAgent(defaultAgent.id);
    } else {
      // Re-render editor for currently selected agent
      const current = host.personas.find((p) => p.id === selectedAgentId);
      if (current) renderAgentEditor(current);
      else {
        selectedAgentId = null;
        renderAgentEditorPlaceholder();
      }
    }
  }

  function renderAgentsSidebar(): void {
    agentsSelectionList.innerHTML = "";
    // Sort: @agent always first, then alphabetical
    const sorted = [...host.personas].sort((a, b) => {
      if (a.handle === host.DEFAULT_AGENT_HANDLE) return -1;
      if (b.handle === host.DEFAULT_AGENT_HANDLE) return 1;
      return a.handle.localeCompare(b.handle);
    });
    for (const persona of sorted) {
      const item = document.createElement("div");
      item.className = "agent-list-item" + (persona.id === selectedAgentId ? " active" : "");
      item.dataset.agentId = persona.id;

      const emoji = document.createElement("span");
      emoji.className = "agent-list-emoji";
      emoji.textContent = persona.emoji || "🤖";

      const handle = document.createElement("span");
      handle.className = "agent-list-handle";
      handle.textContent = "@" + persona.handle;

      item.appendChild(emoji);
      item.appendChild(handle);
      item.addEventListener("click", () => selectAgent(persona.id));
      agentsSelectionList.appendChild(item);
    }
  }

  function selectAgent(agentId: string): void {
    if (host.settingsDrafts.hasDirty()) {
      host.showStatus("Save or cancel the current settings edits before switching agents.", true);
      return;
    }
    selectedAgentId = agentId;
    // Update active state in list
    agentsSelectionList.querySelectorAll(".agent-list-item").forEach((el) => {
      el.classList.toggle("active", (el as HTMLElement).dataset.agentId === agentId);
    });
    const persona = host.personas.find((p) => p.id === agentId);
    if (persona) renderAgentEditor(persona);
  }

  function renderAgentEditorPlaceholder(): void {
    agentsEditor.innerHTML =
      '<div class="agents-editor-placeholder">Select an agent to edit its settings.</div>';
  }

  function renderAgentEditor(persona: AgentPersona): void {
    agentsEditor.innerHTML = "";
    const isDefault = persona.handle === host.DEFAULT_AGENT_HANDLE;

    const form = document.createElement("div");
    form.className = "persona-form";
    form.style.border = "none";
    form.style.padding = "0";
    form.style.background = "none";

    // Handle input — with emoji picker
    const handleRow = document.createElement("div");
    handleRow.className = "persona-form-row";
    const emojiBtn = document.createElement("button");
    emojiBtn.type = "button";
    emojiBtn.className = "emoji-picker-btn";
    emojiBtn.textContent = persona.emoji || "🤖";
    emojiBtn.title = "Pick emoji avatar";
    let selectedEmoji = persona.emoji || "";

    const EMOJI_OPTIONS = [
      "😀",
      "😎",
      "🤖",
      "👻",
      "🦊",
      "🐱",
      "🐶",
      "🦁",
      "🧠",
      "💡",
      "🔥",
      "⚡",
      "🚀",
      "🎯",
      "💻",
      "🛡️",
      "🌟",
      "🎨",
      "🔮",
      "🧪",
      "🪄",
      "👾",
      "🤠",
      "🥷",
      "🦄",
      "🐙",
      "🦅",
      "🐝",
      "🌈",
      "❄️",
      "🌊",
      "🍀",
    ];

    emojiBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const existing_popup = document.querySelector(".emoji-picker-popup");
      if (existing_popup) {
        existing_popup.remove();
        return;
      }

      const popup = document.createElement("div");
      popup.className = "emoji-picker-popup";
      for (const em of EMOJI_OPTIONS) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.textContent = em;
        btn.addEventListener("click", (ev) => {
          ev.stopPropagation();
          selectedEmoji = em;
          host.settingsDrafts.changed(form);
          emojiBtn.textContent = em;
          popup.remove();
        });
        popup.appendChild(btn);
      }

      const clearBtn = document.createElement("button");
      clearBtn.type = "button";
      clearBtn.textContent = "✕";
      clearBtn.title = "Clear emoji";
      clearBtn.style.color = "#999";
      clearBtn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        selectedEmoji = "";
        host.settingsDrafts.changed(form);
        emojiBtn.textContent = "🤖";
        popup.remove();
      });
      popup.appendChild(clearBtn);

      emojiBtn.style.position = "relative";
      emojiBtn.appendChild(popup);

      const closePopup = () => {
        popup.remove();
        document.removeEventListener("click", closePopup);
      };
      setTimeout(() => document.addEventListener("click", closePopup), 0);
    });

    const handleLabel = document.createElement("label");
    handleLabel.textContent = "@";
    handleLabel.className = "persona-handle-prefix";
    const handleInput = document.createElement("input");
    handleInput.type = "text";
    handleInput.className = "persona-form-input";
    handleInput.placeholder = "handle";
    handleInput.value = persona.handle;
    handleInput.maxLength = 32;
    if (isDefault) {
      handleInput.readOnly = true;
      handleInput.style.opacity = "0.6";
      handleInput.title = "The default agent handle cannot be changed";
    }
    handleRow.appendChild(emojiBtn);
    handleRow.appendChild(handleLabel);
    handleRow.appendChild(handleInput);

    // Instructions textarea
    const instrRow = document.createElement("div");
    instrRow.className = "persona-form-row";
    const instrInput = document.createElement("textarea");
    instrInput.className = "persona-form-textarea";
    instrInput.placeholder = "Instructions for this agent...";
    instrInput.value = persona.instructions;
    instrInput.rows = 4;
    instrInput.maxLength = 2000;
    instrRow.appendChild(instrInput);

    // Model dropdown
    const modelRow = document.createElement("div");
    modelRow.className = "persona-form-row";
    const modelLabel = document.createElement("label");
    modelLabel.textContent = "Model";
    modelLabel.className = "persona-form-label";
    const modelSelect = document.createElement("select");
    modelSelect.className = "persona-form-select";

    const defaultOpt = document.createElement("option");
    defaultOpt.value = "";
    defaultOpt.textContent = "Default";
    modelSelect.appendChild(defaultOpt);

    for (const m of personaModels) {
      const opt = document.createElement("option");
      opt.value = m.id;
      opt.textContent = m.name || m.id;
      if (m.id === persona.model) opt.selected = true;
      modelSelect.appendChild(opt);
    }

    modelRow.appendChild(modelLabel);
    modelRow.appendChild(modelSelect);

    // Run location dropdown
    const locationRow = document.createElement("div");
    locationRow.className = "persona-form-row";
    const locationLabel = document.createElement("label");
    locationLabel.textContent = "Run location";
    locationLabel.className = "persona-form-label";
    const locationSelect = document.createElement("select");
    locationSelect.className = "persona-form-select";
    const localOpt = document.createElement("option");
    localOpt.value = "local";
    localOpt.textContent = "💻 Local";
    const cloudOpt = document.createElement("option");
    cloudOpt.value = "cloud";
    cloudOpt.textContent = "☁️ Cloud";
    const ccaOpt = document.createElement("option");
    ccaOpt.value = "cca";
    ccaOpt.textContent = "🤖 Copilot Cloud Agent";
    locationSelect.appendChild(localOpt);
    locationSelect.appendChild(cloudOpt);
    locationSelect.appendChild(ccaOpt);
    if (persona.runLocation === "cca") ccaOpt.selected = true;
    else if (persona.runLocation === "cloud") cloudOpt.selected = true;
    locationRow.appendChild(locationLabel);
    locationRow.appendChild(locationSelect);

    // Sandbox checkbox (available on all platforms with runtime sandbox support)
    const sandboxRow = document.createElement("div");
    sandboxRow.className = "persona-form-row persona-sandbox-row";
    if (persona.runLocation !== "local") {
      sandboxRow.style.display = "none";
    }
    const sandboxLabel = document.createElement("label");
    sandboxLabel.className = "persona-form-checkbox-label";
    const sandboxCheck = document.createElement("input");
    sandboxCheck.type = "checkbox";
    sandboxCheck.checked = persona.sandboxed === true;
    sandboxLabel.appendChild(sandboxCheck);
    sandboxLabel.appendChild(
      document.createTextNode(" 🔒 Run in sandbox (restrict writes & dangerous commands)"),
    );
    sandboxRow.appendChild(sandboxLabel);

    const sandboxInfoNote = document.createElement("div");
    sandboxInfoNote.className = "persona-sandbox-info";
    sandboxInfoNote.textContent =
      "ℹ The agent's working directory is always included in read/write paths.";
    sandboxInfoNote.style.display = sandboxCheck.checked ? "" : "none";
    sandboxRow.appendChild(sandboxInfoNote);

    locationSelect.addEventListener("change", () => {
      if (locationSelect.value !== "local") {
        sandboxRow.style.display = "none";
        sandboxCheck.checked = false;
        sandboxOverrideRow.style.display = "none";
      } else {
        sandboxRow.style.display = "";
        updateSandboxOverrideVisibility();
      }
    });

    // Sandbox override
    const sandboxOverrideRow = document.createElement("div");
    sandboxOverrideRow.className = "persona-form-row persona-sandbox-override-row";
    sandboxOverrideRow.style.display = "none";
    sandboxOverrideRow.style.flexDirection = "column";
    sandboxOverrideRow.style.gap = "6px";

    const inheritLabel = document.createElement("label");
    inheritLabel.className = "persona-form-checkbox-label";
    const inheritCheck = document.createElement("input");
    inheritCheck.type = "checkbox";
    // For @agent, there's no "inherit" — it IS the default
    if (isDefault) {
      inheritCheck.checked = false;
      inheritLabel.style.display = "none";
    } else {
      inheritCheck.checked = persona.sandboxPolicyOverride == null;
    }
    inheritLabel.appendChild(inheritCheck);
    inheritLabel.appendChild(document.createTextNode(" Inherit sandbox policy from @agent"));
    sandboxOverrideRow.appendChild(inheritLabel);

    const overrideContainer = document.createElement("div");
    overrideContainer.className = "sandbox-policy-form";
    overrideContainer.style.display = isDefault || !inheritCheck.checked ? "" : "none";
    sandboxOverrideRow.appendChild(overrideContainer);

    let personaPolicyApi: {
      getPolicy: () => SandboxPolicy;
      setPolicy: (p: SandboxPolicy) => void;
    } | null = null;

    async function ensurePolicyForm(): Promise<void> {
      if (personaPolicyApi) return;
      let initial: SandboxPolicy;
      if (isDefault) {
        // @agent reads/writes the global default sandbox policy
        try {
          initial = (await host.whimAPI.getSandboxDefaultPolicy()) ?? host.DEFAULT_SANDBOX_POLICY;
        } catch {
          initial = host.DEFAULT_SANDBOX_POLICY;
        }
      } else if (persona.sandboxPolicyOverride) {
        initial = persona.sandboxPolicyOverride;
      } else {
        try {
          initial = (await host.whimAPI.getSandboxDefaultPolicy()) ?? host.DEFAULT_SANDBOX_POLICY;
        } catch {
          initial = host.DEFAULT_SANDBOX_POLICY;
        }
      }
      personaPolicyApi = renderSandboxPolicyForm(overrideContainer, initial, {
        idPrefix: `persona-${persona.id}`,
      });
    }

    inheritCheck.addEventListener("change", async () => {
      if (inheritCheck.checked) {
        overrideContainer.style.display = "none";
      } else {
        await ensurePolicyForm();
        overrideContainer.style.display = "";
      }
    });

    function updateSandboxOverrideVisibility(): void {
      const show = sandboxCheck.checked && locationSelect.value === "local";
      sandboxInfoNote.style.display = show ? "" : "none";
      if (show) {
        sandboxOverrideRow.style.display = "";
        if (isDefault || !inheritCheck.checked) ensurePolicyForm();
      } else {
        sandboxOverrideRow.style.display = "none";
      }
    }
    sandboxCheck.addEventListener("change", updateSandboxOverrideVisibility);
    if (sandboxCheck.checked) updateSandboxOverrideVisibility();

    // CLI Runtime dropdown
    const runtimeRow = document.createElement("div");
    runtimeRow.className = "persona-form-row";
    const runtimeLabel = document.createElement("label");
    runtimeLabel.textContent = "CLI Runtime";
    runtimeLabel.className = "persona-form-label";
    const runtimeSelect = document.createElement("select");
    runtimeSelect.className = "persona-form-select";
    const defaultRtOpt = document.createElement("option");
    defaultRtOpt.value = "";
    defaultRtOpt.textContent = "Default";
    runtimeSelect.appendChild(defaultRtOpt);
    host.whimAPI.listRuntimes().then((runtimes) => {
      for (const rt of runtimes) {
        const opt = document.createElement("option");
        opt.value = rt.id;
        opt.textContent = rt.label;
        if (rt.id === persona.cliRuntime) opt.selected = true;
        runtimeSelect.appendChild(opt);
      }
    });
    runtimeRow.appendChild(runtimeLabel);
    runtimeRow.appendChild(runtimeSelect);

    // Yolo mode checkbox
    const yoloRow = document.createElement("div");
    yoloRow.className = "persona-form-row persona-yolo-row";
    const yoloLabel = document.createElement("label");
    yoloLabel.className = "persona-form-checkbox-label";
    const yoloCheck = document.createElement("input");
    yoloCheck.type = "checkbox";
    yoloCheck.checked = persona.yolo === true;
    yoloLabel.appendChild(yoloCheck);
    yoloLabel.appendChild(
      document.createTextNode(" 🔥 Auto-enable yolo mode (skip all permission prompts)"),
    );
    yoloRow.appendChild(yoloLabel);

    // Ephemeral mode checkbox
    const ephemeralRow = document.createElement("div");
    ephemeralRow.className = "persona-form-row persona-ephemeral-row";
    if (persona.runLocation === "cca") {
      ephemeralRow.style.display = "none";
    }
    const ephemeralLabel = document.createElement("label");
    ephemeralLabel.className = "persona-form-checkbox-label";
    const ephemeralCheck = document.createElement("input");
    ephemeralCheck.type = "checkbox";
    ephemeralCheck.checked = persona.ephemeral === true;
    ephemeralLabel.appendChild(ephemeralCheck);
    ephemeralLabel.appendChild(
      document.createTextNode(
        " 🕵️ Ephemeral mode (no session history — nothing persisted to disk or DB)",
      ),
    );
    ephemeralRow.appendChild(ephemeralLabel);

    // Hide ephemeral option for CCA personas
    locationSelect.addEventListener("change", () => {
      if (locationSelect.value === "cca") {
        ephemeralRow.style.display = "none";
        ephemeralCheck.checked = false;
      } else {
        ephemeralRow.style.display = "";
      }
    });

    // Error display
    const errorEl = document.createElement("div");
    errorEl.className = "persona-form-error hidden";

    // Action buttons
    const btnRow = document.createElement("div");
    btnRow.className = "persona-form-actions";

    const saveBtn = document.createElement("button");
    saveBtn.className = "persona-form-save";
    saveBtn.textContent = "Save";
    saveBtn.addEventListener("click", async () => {
      const formRevision = host.settingsDrafts.revision(form);
      const rawHandle = isDefault
        ? host.DEFAULT_AGENT_HANDLE
        : handleInput.value.trim().replace(/^@/, "").toLowerCase();
      const instructions = instrInput.value.trim();
      const model = modelSelect.value;
      const runLocation = locationSelect.value as "local" | "cca" | "cloud";
      const sandboxed = sandboxCheck.checked && runLocation === "local";
      const emoji = selectedEmoji;
      const cliRuntime = runtimeSelect.value;

      // For @agent, save sandbox policy to global default as well.
      // ensurePolicyForm() is materialized lazily (and its callers don't await
      // it), so read through it here — otherwise a quick check-then-save would
      // see personaPolicyApi === null and silently drop the policy.
      let sandboxOverride: SandboxPolicy | undefined;
      if (sandboxed) {
        if (isDefault) {
          await ensurePolicyForm();
          if (personaPolicyApi) {
            await host.whimAPI.saveSandboxDefaultPolicy(personaPolicyApi.getPolicy());
          }
          sandboxOverride = undefined; // @agent uses the global default
        } else if (!inheritCheck.checked) {
          await ensurePolicyForm();
          // Fall back to the persona's stored override rather than wiping it
          // if the form still couldn't be built.
          sandboxOverride = personaPolicyApi
            ? personaPolicyApi.getPolicy()
            : persona.sandboxPolicyOverride;
        }
      } else if (!isDefault) {
        // Sandboxing is off — main drops sandboxPolicyOverride in that case,
        // so leave it undefined here to stay in sync with what's persisted.
        sandboxOverride = undefined;
      }

      if (!isDefault && !HANDLE_RE.test(rawHandle)) {
        errorEl.textContent = "Handle must be 1-32 lowercase letters, numbers, or dashes.";
        errorEl.classList.remove("hidden");
        return;
      }
      if (!instructions) {
        errorEl.textContent = "Instructions are required.";
        errorEl.classList.remove("hidden");
        return;
      }
      if (!isDefault) {
        const duplicate = host.personas.find((p) => p.handle === rawHandle && p.id !== persona.id);
        if (duplicate) {
          errorEl.textContent = `Handle @${rawHandle} is already taken.`;
          errorEl.classList.remove("hidden");
          return;
        }
      }

      host.personas = host.personas.map((p) =>
        p.id === persona.id
          ? {
              ...p,
              handle: rawHandle,
              instructions,
              model,
              runLocation,
              emoji: emoji || undefined,
              cliRuntime: cliRuntime || undefined,
              ...(sandboxed ? { sandboxed: true } : { sandboxed: undefined }),
              ...(sandboxOverride
                ? { sandboxPolicyOverride: sandboxOverride }
                : { sandboxPolicyOverride: undefined }),
              ...(yoloCheck.checked ? { yolo: true } : { yolo: undefined }),
              ...(ephemeralCheck.checked && (runLocation === "local" || runLocation === "cloud")
                ? { ephemeral: true }
                : { ephemeral: undefined }),
            }
          : p,
      );

      const result = await host.whimAPI.savePersonas(host.personas);
      if (result && "error" in result) {
        errorEl.textContent = result.error || "Unable to save personas.";
        errorEl.className = "persona-form-error";
        errorEl.classList.remove("hidden");
        return;
      }
      if (!host.settingsDrafts.saved(form, formRevision)) {
        errorEl.textContent = "Newer edits are not saved yet.";
        errorEl.classList.remove("hidden");
        return;
      }
      // Adopt the persisted list. Main-side validation normalizes fields and
      // silently drops incomplete entries (e.g. an untouched "+ Add" draft), so
      // keeping the optimistic array would leave ghost rows in the sidebar.
      await host.loadPersonasSnapshot(host.bridgeApi, { force: true, invalidate: true });
      host.personas = [...host.personaStore.getState().personas];
      renderAgentsSidebar();
      // Show animated save confirmation
      errorEl.textContent = "✓ Saved";
      errorEl.className = "persona-form-error persona-save-toast";
      errorEl.classList.remove("hidden");
      setTimeout(() => {
        errorEl.classList.add("hidden");
        errorEl.className = "persona-form-error hidden";
      }, 2000);
    });

    const deleteBtn = document.createElement("button");
    deleteBtn.className = "persona-form-cancel";
    deleteBtn.textContent = "Delete";
    deleteBtn.style.color = "#b91414";
    if (isDefault) {
      deleteBtn.style.display = "none";
    }
    deleteBtn.addEventListener("click", async () => {
      if (isDefault) return;
      host.personas = host.personas.filter((p) => p.id !== persona.id);
      await host.whimAPI.savePersonas(host.personas);
      await host.loadPersonasSnapshot(host.bridgeApi, { force: true, invalidate: true });
      host.personas = [...host.personaStore.getState().personas];
      selectedAgentId = null;
      renderAgentsSidebar();
      // Select @agent after deletion
      const defaultAgent = host.personas.find((p) => p.handle === host.DEFAULT_AGENT_HANDLE);
      if (defaultAgent) selectAgent(defaultAgent.id);
      else renderAgentEditorPlaceholder();
    });

    btnRow.appendChild(saveBtn);
    btnRow.appendChild(deleteBtn);
    const cancelEditsBtn = document.createElement("button");
    cancelEditsBtn.type = "button";
    cancelEditsBtn.className = "persona-form-cancel";
    cancelEditsBtn.textContent = "Cancel edits";
    cancelEditsBtn.addEventListener("click", () => {
      host.settingsDrafts.saved(form, host.settingsDrafts.revision(form));
      host.settingWrites.discardFailure("savePersonas");
      renderAgentEditor(
        host.personaStore.getState().personas.find((item) => item.id === persona.id) ?? persona,
      );
    });
    btnRow.appendChild(cancelEditsBtn);

    // "Open config preview" — materializes the persona's current sandbox
    // policy to a config.json file under userData/sandbox-config/preview/ and
    // opens it in the OS default text editor. Lets the user verify exactly
    // which config the runtime will load at agent launch (companion to the
    // [sandbox] launch-time logs in main).
    const previewBtn = document.createElement("button");
    previewBtn.className = "persona-form-cancel";
    previewBtn.type = "button";
    previewBtn.textContent = "Open config preview";
    previewBtn.title =
      "Materialize the runtime config.json for this policy and open it in your default text editor.";
    previewBtn.style.marginLeft = "auto";
    previewBtn.addEventListener("click", async () => {
      if (!sandboxCheck.checked) {
        errorEl.textContent = 'Enable "Run in sandbox" to preview the config.';
        errorEl.classList.remove("hidden");
        return;
      }
      // Materialize the policy form lazily — covers both inherit-from-default
      // and explicit-override cases. Either way personaPolicyApi.getPolicy()
      // returns the values that would be saved on click.
      await ensurePolicyForm();
      if (!personaPolicyApi) {
        errorEl.textContent = "Could not load sandbox policy form.";
        errorEl.classList.remove("hidden");
        return;
      }
      const policy = personaPolicyApi.getPolicy();
      const result = await host.whimAPI.openSandboxConfigPreview(policy);
      if (result?.ok) {
        errorEl.textContent = `Opened ${result.path}`;
        errorEl.style.color = "#2d8a3a";
        errorEl.classList.remove("hidden");
        setTimeout(() => {
          errorEl.classList.add("hidden");
          errorEl.style.color = "";
        }, 2500);
      } else {
        errorEl.textContent = result?.error || "Failed to open config preview";
        errorEl.classList.remove("hidden");
      }
    });
    // Hide the preview button when sandbox is off (or the platform doesn't
    // support sandboxing at all) — there's nothing meaningful to materialize.
    const updatePreviewVisibility = () => {
      previewBtn.style.display = sandboxCheck.checked ? "" : "none";
    };
    updatePreviewVisibility();
    sandboxCheck.addEventListener("change", updatePreviewVisibility);
    btnRow.appendChild(previewBtn);

    form.appendChild(handleRow);
    form.appendChild(instrRow);
    form.appendChild(modelRow);
    form.appendChild(locationRow);
    form.appendChild(sandboxRow);
    form.appendChild(sandboxOverrideRow);
    form.appendChild(runtimeRow);
    form.appendChild(yoloRow);
    form.appendChild(ephemeralRow);
    form.appendChild(errorEl);
    form.appendChild(btnRow);

    agentsEditor.appendChild(form);
  }

  personaAddBtn.addEventListener("click", () => {
    const newId = crypto.randomUUID();
    const newPersona: AgentPersona = {
      id: newId,
      handle: "",
      instructions: "",
      model: "",
      runLocation: "local",
    };
    host.personas.push(newPersona);
    host.personaStore.setPersonas(host.personas);
    renderAgentsSidebar();
    selectAgent(newId);
  });

  // ── CLI Runtimes ────────────────────────────────────────
  const runtimesList = document.getElementById("runtimes-list") as HTMLDivElement;
  const runtimeAddBtn = document.getElementById("runtime-add-btn") as HTMLButtonElement;
  let cliRuntimes: CliRuntime[] = [];

  async function loadRuntimes(): Promise<void> {
    cliRuntimes = (await host.whimAPI.listRuntimes()) || [];
    renderRuntimes();
  }

  function renderRuntimes(): void {
    const openForm = runtimesList.querySelector(".persona-form");
    runtimesList.innerHTML = "";
    for (const rt of cliRuntimes) {
      runtimesList.appendChild(createRuntimeCard(rt));
    }
    if (openForm) runtimesList.appendChild(openForm);
  }

  function createRuntimeCard(rt: CliRuntime): HTMLElement {
    const card = document.createElement("div");
    card.className = "persona-card";

    const info = document.createElement("div");
    info.className = "persona-card-info";

    const label = document.createElement("div");
    label.className = "persona-card-handle";
    label.textContent = rt.label;

    const pathEl = document.createElement("div");
    pathEl.className = "persona-card-instructions";
    pathEl.textContent = rt.path;

    info.appendChild(label);
    info.appendChild(pathEl);

    const actions = document.createElement("div");
    actions.className = "persona-card-actions";

    const editBtn = document.createElement("button");
    editBtn.className = "persona-action-btn";
    editBtn.textContent = "✎";
    editBtn.title = "Edit";
    editBtn.addEventListener("click", () => showRuntimeForm(rt));

    const delBtn = document.createElement("button");
    delBtn.className = "persona-action-btn danger";
    delBtn.textContent = "✕";
    delBtn.title = "Delete";
    delBtn.addEventListener("click", async () => {
      cliRuntimes = cliRuntimes.filter((r) => r.id !== rt.id);
      await host.whimAPI.saveRuntimes(cliRuntimes);
      renderRuntimes();
    });

    actions.appendChild(editBtn);
    actions.appendChild(delBtn);

    card.appendChild(info);
    card.appendChild(actions);
    return card;
  }

  function showRuntimeForm(existing?: CliRuntime): void {
    const prev = runtimesList.querySelector(".persona-form");
    if (prev) prev.remove();

    const form = document.createElement("div");
    form.className = "persona-form";

    const labelRow = document.createElement("div");
    labelRow.className = "persona-form-row";
    const labelInput = document.createElement("input");
    labelInput.type = "text";
    labelInput.className = "persona-form-input";
    labelInput.placeholder = "Label (e.g. Copilot Dev)";
    labelInput.value = existing?.label || "";
    labelInput.maxLength = 50;
    labelRow.appendChild(labelInput);

    const pathRow = document.createElement("div");
    pathRow.className = "persona-form-row";
    const pathInput = document.createElement("input");
    pathInput.type = "text";
    pathInput.className = "persona-form-input";
    pathInput.placeholder = "Path or command (e.g. copilot-dev)";
    pathInput.value = existing?.path || "";
    pathInput.spellcheck = false;
    pathRow.appendChild(pathInput);

    const errorEl = document.createElement("div");
    errorEl.className = "persona-form-error hidden";

    const btnRow = document.createElement("div");
    btnRow.className = "persona-form-actions";

    const saveBtn = document.createElement("button");
    saveBtn.className = "persona-form-save";
    saveBtn.textContent = existing ? "Save" : "Add";
    saveBtn.addEventListener("click", async () => {
      const label = labelInput.value.trim();
      const rPath = pathInput.value.trim();
      const formRevision = host.settingsDrafts.revision(form);
      if (!label) {
        errorEl.textContent = "Label is required.";
        errorEl.classList.remove("hidden");
        return;
      }
      if (!rPath) {
        errorEl.textContent = "Path is required.";
        errorEl.classList.remove("hidden");
        return;
      }

      if (existing) {
        cliRuntimes = cliRuntimes.map((r) =>
          r.id === existing.id ? { ...r, label, path: rPath } : r,
        );
      } else {
        cliRuntimes.push({ id: crypto.randomUUID(), label, path: rPath });
      }

      const result = await host.whimAPI.saveRuntimes(cliRuntimes);
      if (result && "error" in result) {
        errorEl.textContent = result.error || "Settings save failed";
        errorEl.classList.remove("hidden");
        return;
      }
      // Update local state with resolved paths from the backend
      if (result && result.runtimes) {
        cliRuntimes = result.runtimes;
      }
      if (!host.settingsDrafts.saved(form, formRevision)) return;
      form.remove();
      renderRuntimes();
    });

    const cancelBtn = document.createElement("button");
    cancelBtn.className = "persona-form-cancel";
    cancelBtn.textContent = "Cancel";
    cancelBtn.addEventListener("click", () => form.remove());

    btnRow.appendChild(saveBtn);
    btnRow.appendChild(cancelBtn);

    form.appendChild(labelRow);
    form.appendChild(pathRow);
    form.appendChild(errorEl);
    form.appendChild(btnRow);

    runtimesList.appendChild(form);
    labelInput.focus();
  }

  runtimeAddBtn.addEventListener("click", () => showRuntimeForm());

  // ── Export Destinations ─────────────────────────────────
  const exportDestinationsList = document.getElementById(
    "export-destinations-list",
  ) as HTMLDivElement;
  const exportDestAddBtn = document.getElementById("export-dest-add-btn") as HTMLButtonElement;
  let exportDestinations: ExportDestination[] = [];

  const EXPORT_FORMAT_LABELS: Record<ExportFormat, string> = {
    pdf: "PDF",
    docx: "Word",
    md: "Markdown",
  };

  async function loadExportDestinations(): Promise<void> {
    exportDestinations = (await host.whimAPI.listExportDestinations()) || [];
    renderExportDestinations();
  }

  function renderExportDestinations(): void {
    const openForm = exportDestinationsList.querySelector(".persona-form");
    exportDestinationsList.innerHTML = "";
    for (const dest of exportDestinations) {
      exportDestinationsList.appendChild(createExportDestCard(dest));
    }
    if (openForm) exportDestinationsList.appendChild(openForm);
  }

  function createExportDestCard(dest: ExportDestination): HTMLElement {
    const card = document.createElement("div");
    card.className = "persona-card";

    const info = document.createElement("div");
    info.className = "persona-card-info";

    const label = document.createElement("div");
    label.className = "persona-card-handle";
    label.textContent = `${dest.label} · ${EXPORT_FORMAT_LABELS[dest.defaultFormat]}`;

    const pathEl = document.createElement("div");
    pathEl.className = "persona-card-instructions";
    pathEl.textContent = dest.path;

    info.appendChild(label);
    info.appendChild(pathEl);

    const actions = document.createElement("div");
    actions.className = "persona-card-actions";

    const editBtn = document.createElement("button");
    editBtn.className = "persona-action-btn";
    editBtn.textContent = "✎";
    editBtn.title = "Edit";
    editBtn.addEventListener("click", () => showExportDestForm(dest));

    const delBtn = document.createElement("button");
    delBtn.className = "persona-action-btn danger";
    delBtn.textContent = "✕";
    delBtn.title = "Delete";
    delBtn.addEventListener("click", async () => {
      exportDestinations = exportDestinations.filter((d) => d.id !== dest.id);
      await host.whimAPI.saveExportDestinations(exportDestinations);
      renderExportDestinations();
    });

    actions.appendChild(editBtn);
    actions.appendChild(delBtn);

    card.appendChild(info);
    card.appendChild(actions);
    return card;
  }

  function showExportDestForm(existing?: ExportDestination): void {
    const prev = exportDestinationsList.querySelector(".persona-form");
    if (prev) prev.remove();

    const form = document.createElement("div");
    form.className = "persona-form";

    const labelRow = document.createElement("div");
    labelRow.className = "persona-form-row";
    const labelInput = document.createElement("input");
    labelInput.type = "text";
    labelInput.className = "persona-form-input";
    labelInput.placeholder = "Label (e.g. Work SharePoint)";
    labelInput.value = existing?.label || "";
    labelInput.maxLength = 50;
    labelRow.appendChild(labelInput);

    const pathRow = document.createElement("div");
    pathRow.className = "persona-form-row export-dest-path-row";
    const pathInput = document.createElement("input");
    pathInput.type = "text";
    pathInput.className = "persona-form-input";
    pathInput.placeholder = "Folder path (e.g. ~/OneDrive/Shared)";
    pathInput.value = existing?.path || "";
    pathInput.spellcheck = false;
    const browseBtn = document.createElement("button");
    browseBtn.className = "workspace-btn";
    browseBtn.type = "button";
    browseBtn.textContent = "Browse…";
    browseBtn.addEventListener("click", async () => {
      const result = await host.whimAPI.selectFolder({ title: "Select export destination folder" });
      if ("path" in result) pathInput.value = result.path;
    });
    pathRow.appendChild(pathInput);
    pathRow.appendChild(browseBtn);

    const formatRow = document.createElement("div");
    formatRow.className = "persona-form-row";
    const formatSelect = document.createElement("select");
    formatSelect.className = "persona-form-input";
    for (const fmt of ["pdf", "docx", "md"] as ExportFormat[]) {
      const opt = document.createElement("option");
      opt.value = fmt;
      opt.textContent = `Default format: ${EXPORT_FORMAT_LABELS[fmt]}`;
      if ((existing?.defaultFormat || "pdf") === fmt) opt.selected = true;
      formatSelect.appendChild(opt);
    }
    formatRow.appendChild(formatSelect);

    const errorEl = document.createElement("div");
    errorEl.className = "persona-form-error hidden";

    const btnRow = document.createElement("div");
    btnRow.className = "persona-form-actions";

    const saveBtn = document.createElement("button");
    saveBtn.className = "persona-form-save";
    saveBtn.textContent = existing ? "Save" : "Add";
    saveBtn.addEventListener("click", async () => {
      const label = labelInput.value.trim();
      const destPath = pathInput.value.trim();
      const formRevision = host.settingsDrafts.revision(form);
      const defaultFormat = formatSelect.value as ExportFormat;
      if (!label) {
        errorEl.textContent = "Label is required.";
        errorEl.classList.remove("hidden");
        return;
      }
      if (!destPath) {
        errorEl.textContent = "Folder path is required.";
        errorEl.classList.remove("hidden");
        return;
      }

      if (existing) {
        exportDestinations = exportDestinations.map((d) =>
          d.id === existing.id ? { ...d, label, path: destPath, defaultFormat } : d,
        );
      } else {
        exportDestinations.push({ id: crypto.randomUUID(), label, path: destPath, defaultFormat });
      }

      const result = await host.whimAPI.saveExportDestinations(exportDestinations);
      if ("error" in result) {
        errorEl.textContent = result.error || "Settings save failed";
        errorEl.classList.remove("hidden");
        return;
      }
      if ("destinations" in result) exportDestinations = result.destinations;
      if (!host.settingsDrafts.saved(form, formRevision)) return;
      form.remove();
      renderExportDestinations();
    });

    const cancelBtn = document.createElement("button");
    cancelBtn.className = "persona-form-cancel";
    cancelBtn.textContent = "Cancel";
    cancelBtn.addEventListener("click", () => form.remove());

    btnRow.appendChild(saveBtn);
    btnRow.appendChild(cancelBtn);

    form.appendChild(labelRow);
    form.appendChild(pathRow);
    form.appendChild(formatRow);
    form.appendChild(errorEl);
    form.appendChild(btnRow);

    exportDestinationsList.appendChild(form);
    labelInput.focus();
  }

  exportDestAddBtn?.addEventListener("click", () => showExportDestForm());

  // ── MCP Servers ─────────────────────────────────────────
  const mcpDiscoveredList = document.getElementById("mcp-discovered-list") as HTMLDivElement;
  const mcpCustomList = document.getElementById("mcp-custom-list") as HTMLDivElement;
  const mcpAddBtn = document.getElementById("mcp-add-btn") as HTMLButtonElement;
  let customMcpServers: CustomMcpServer[] = [];

  async function loadMcpServers(): Promise<void> {
    // Load discovered MCPs
    try {
      const discovered: DiscoveredMcpServer[] = await host.whimAPI.listDiscoveredMcp();
      mcpDiscoveredList.innerHTML = "";
      for (const s of discovered) {
        mcpDiscoveredList.appendChild(createMcpCard(s, true));
      }
    } catch {
      mcpDiscoveredList.innerHTML = "";
    }

    // Load custom MCPs
    try {
      customMcpServers = (await host.whimAPI.listCustomMcp()) || [];
      renderCustomMcpServers();
    } catch {
      customMcpServers = [];
    }
  }

  function renderCustomMcpServers(): void {
    mcpCustomList.innerHTML = "";
    for (const s of customMcpServers) {
      mcpCustomList.appendChild(createMcpCard(s, false));
    }
  }

  function createMcpCard(
    server: DiscoveredMcpServer | CustomMcpServer,
    isDiscovered: boolean,
  ): HTMLElement {
    const card = document.createElement("div");
    card.className = "mcp-card";

    const info = document.createElement("div");
    info.className = "mcp-card-info";

    const name = document.createElement("div");
    name.className = "mcp-card-name";
    name.textContent = (server as any).name;

    const meta = document.createElement("div");
    meta.className = "mcp-card-meta";
    const type = (server as any).type || "stdio";
    const detail =
      type === "http" || type === "sse" ? (server as any).url || "" : (server as any).command || "";
    meta.textContent = `${type}${detail ? " · " + detail : ""}`;

    if (isDiscovered) {
      const source = document.createElement("span");
      source.className = "mcp-card-source";
      source.textContent =
        (server as DiscoveredMcpServer).source === "plugin" ? " (plugin)" : " (config)";
      meta.appendChild(source);
    }

    info.appendChild(name);
    info.appendChild(meta);
    card.appendChild(info);

    if (!isDiscovered) {
      const delBtn = document.createElement("button");
      delBtn.className = "persona-action-btn danger";
      delBtn.textContent = "✕";
      delBtn.title = "Remove";
      delBtn.addEventListener("click", async () => {
        customMcpServers = customMcpServers.filter(
          (s) => s.name !== (server as CustomMcpServer).name,
        );
        await host.whimAPI.saveCustomMcp(customMcpServers);
        customMcpServers = (await host.whimAPI.listCustomMcp()) || [];
        renderCustomMcpServers();
      });
      card.appendChild(delBtn);
    }

    return card;
  }

  function showMcpForm(): void {
    // The form is rendered with class `persona-form` — matching on `.mcp-form`
    // here never hit, so repeated "+ Add" clicks stacked duplicate forms.
    const prev = mcpCustomList.querySelector(".persona-form");
    if (prev) prev.remove();

    const form = document.createElement("div");
    form.className = "persona-form";

    // Name
    const nameRow = document.createElement("div");
    nameRow.className = "persona-form-row";
    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.className = "persona-form-input";
    nameInput.placeholder = "Server name";
    nameRow.appendChild(nameInput);

    // Type select
    const typeRow = document.createElement("div");
    typeRow.className = "persona-form-row";
    const typeLabel = document.createElement("label");
    typeLabel.className = "persona-form-label";
    typeLabel.textContent = "Type";
    const typeSelect = document.createElement("select");
    typeSelect.className = "persona-form-select";
    for (const t of ["stdio", "http", "sse"]) {
      const opt = document.createElement("option");
      opt.value = t;
      opt.textContent = t;
      typeSelect.appendChild(opt);
    }
    typeRow.appendChild(typeLabel);
    typeRow.appendChild(typeSelect);

    // Command (for stdio)
    const cmdRow = document.createElement("div");
    cmdRow.className = "persona-form-row";
    const cmdInput = document.createElement("input");
    cmdInput.type = "text";
    cmdInput.className = "persona-form-input";
    cmdInput.placeholder = "Command (e.g., npx -y @modelcontextprotocol/server-github)";
    cmdRow.appendChild(cmdInput);

    // URL (for http/sse)
    const urlRow = document.createElement("div");
    urlRow.className = "persona-form-row hidden";
    const urlInput = document.createElement("input");
    urlInput.type = "text";
    urlInput.className = "persona-form-input";
    urlInput.placeholder = "URL (e.g., http://localhost:3000/mcp)";
    urlRow.appendChild(urlInput);

    typeSelect.addEventListener("change", () => {
      const isRemote = typeSelect.value === "http" || typeSelect.value === "sse";
      cmdRow.classList.toggle("hidden", isRemote);
      urlRow.classList.toggle("hidden", !isRemote);
    });

    // Error
    const errorEl = document.createElement("div");
    errorEl.className = "persona-form-error hidden";

    // Buttons
    const btnRow = document.createElement("div");
    btnRow.className = "persona-form-actions";
    const saveBtn = document.createElement("button");
    saveBtn.className = "persona-form-save";
    saveBtn.textContent = "Add";
    saveBtn.addEventListener("click", async () => {
      const name = nameInput.value.trim();
      const type = typeSelect.value as "stdio" | "http" | "sse";
      const command = cmdInput.value.trim();
      const url = urlInput.value.trim();
      const formRevision = host.settingsDrafts.revision(form);

      if (!name) {
        errorEl.textContent = "Name is required.";
        errorEl.classList.remove("hidden");
        return;
      }
      if (customMcpServers.some((s) => s.name === name)) {
        errorEl.textContent = "A server with this name already exists.";
        errorEl.classList.remove("hidden");
        return;
      }
      if (type === "stdio" && !command) {
        errorEl.textContent = "Command is required for stdio servers.";
        errorEl.classList.remove("hidden");
        return;
      }
      if ((type === "http" || type === "sse") && !url) {
        errorEl.textContent = "URL is required for remote servers.";
        errorEl.classList.remove("hidden");
        return;
      }

      const entry: CustomMcpServer = {
        name,
        type,
        tools: ["*"],
        ...(type === "stdio" ? { command, args: [] } : { url }),
      };

      customMcpServers.push(entry);
      const result = await host.whimAPI.saveCustomMcp(customMcpServers);
      if (result && "error" in result) {
        customMcpServers = customMcpServers.filter((s) => s !== entry);
        errorEl.textContent = result.error || "Unable to save CLI tools.";
        errorEl.classList.remove("hidden");
        return;
      }
      // Adopt the persisted list — main-side validation may normalize or drop
      // entries, and keeping the optimistic copy would show rows that aren't
      // actually saved.
      customMcpServers = (await host.whimAPI.listCustomMcp()) || [];
      if (!host.settingsDrafts.saved(form, formRevision)) return;
      renderCustomMcpServers();
    });

    const cancelBtn = document.createElement("button");
    cancelBtn.className = "persona-form-cancel";
    cancelBtn.textContent = "Cancel";
    cancelBtn.addEventListener("click", () => form.remove());

    btnRow.appendChild(saveBtn);
    btnRow.appendChild(cancelBtn);

    form.appendChild(nameRow);
    form.appendChild(typeRow);
    form.appendChild(cmdRow);
    form.appendChild(urlRow);
    form.appendChild(errorEl);
    form.appendChild(btnRow);

    mcpCustomList.appendChild(form);
    nameInput.focus();
  }

  mcpAddBtn.addEventListener("click", showMcpForm);

  // ── CLI Tools ───────────────────────────────────────────
  const cliToolsList = document.getElementById("cli-tools-list") as HTMLDivElement;
  const cliToolAddBtn = document.getElementById("cli-tool-add-btn") as HTMLButtonElement;
  let cliTools: CliToolDefinition[] = [];

  async function loadCliTools(): Promise<void> {
    try {
      cliTools = (await host.whimAPI.listCliTools()) || [];
      renderCliTools();
    } catch {
      cliTools = [];
    }
  }

  function renderCliTools(): void {
    cliToolsList.innerHTML = "";
    for (const tool of cliTools) {
      cliToolsList.appendChild(createCliToolCard(tool));
    }
  }

  function createCliToolCard(tool: CliToolDefinition): HTMLElement {
    const card = document.createElement("div");
    card.className = "mcp-card";

    const info = document.createElement("div");
    info.className = "mcp-card-info";

    const name = document.createElement("div");
    name.className = "mcp-card-name";
    name.textContent = tool.name;

    const desc = document.createElement("div");
    desc.className = "mcp-card-meta";
    desc.textContent = tool.description;

    info.appendChild(name);
    info.appendChild(desc);

    const actions = document.createElement("div");
    actions.className = "persona-card-actions";

    const editBtn = document.createElement("button");
    editBtn.className = "persona-action-btn";
    editBtn.textContent = "✎";
    editBtn.title = "Edit";
    editBtn.addEventListener("click", () => showCliToolForm(tool));

    const delBtn = document.createElement("button");
    delBtn.className = "persona-action-btn danger";
    delBtn.textContent = "✕";
    delBtn.title = "Remove";
    delBtn.addEventListener("click", async () => {
      cliTools = cliTools.filter((t) => t.name !== tool.name);
      await host.whimAPI.saveCliTools(cliTools);
      cliTools = (await host.whimAPI.listCliTools()) || [];
      renderCliTools();
    });

    actions.appendChild(editBtn);
    actions.appendChild(delBtn);
    card.appendChild(info);
    card.appendChild(actions);
    return card;
  }

  function showCliToolForm(existing?: CliToolDefinition): void {
    const prev = cliToolsList.querySelector(".persona-form");
    if (prev) prev.remove();

    const form = document.createElement("div");
    form.className = "persona-form";

    const nameRow = document.createElement("div");
    nameRow.className = "persona-form-row";
    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.className = "persona-form-input";
    nameInput.placeholder = "Command name (e.g., gh)";
    nameInput.value = existing?.name || "";
    nameRow.appendChild(nameInput);

    const descRow = document.createElement("div");
    descRow.className = "persona-form-row";
    const descInput = document.createElement("textarea");
    descInput.className = "persona-form-textarea";
    descInput.placeholder =
      "Description (e.g., Used for GitHub operations including git, issues, pull requests, actions)";
    descInput.value = existing?.description || "";
    descInput.rows = 2;
    descInput.maxLength = 500;
    descRow.appendChild(descInput);

    const errorEl = document.createElement("div");
    errorEl.className = "persona-form-error hidden";

    const btnRow = document.createElement("div");
    btnRow.className = "persona-form-actions";
    const saveBtn = document.createElement("button");
    saveBtn.className = "persona-form-save";
    saveBtn.textContent = existing ? "Save" : "Add";
    saveBtn.addEventListener("click", async () => {
      const name = nameInput.value.trim();
      const description = descInput.value.trim();
      const formRevision = host.settingsDrafts.revision(form);

      if (!name) {
        errorEl.textContent = "Command name is required.";
        errorEl.classList.remove("hidden");
        return;
      }
      if (!description) {
        errorEl.textContent = "Description is required.";
        errorEl.classList.remove("hidden");
        return;
      }
      const duplicate = cliTools.find((t) => t.name === name && t.name !== (existing?.name || ""));
      if (duplicate) {
        errorEl.textContent = `Tool "${name}" already exists.`;
        errorEl.classList.remove("hidden");
        return;
      }

      if (existing) {
        cliTools = cliTools.map((t) => (t.name === existing.name ? { name, description } : t));
      } else {
        cliTools = [...cliTools, { name, description }];
      }

      const result = await host.whimAPI.saveCliTools(cliTools);
      if (result && "error" in result) {
        errorEl.textContent = result.error || "Unable to save MCP settings.";
        errorEl.classList.remove("hidden");
        return;
      }
      cliTools = (await host.whimAPI.listCliTools()) || [];
      if (!host.settingsDrafts.saved(form, formRevision)) return;
      renderCliTools();
    });

    const cancelBtn = document.createElement("button");
    cancelBtn.className = "persona-form-cancel";
    cancelBtn.textContent = "Cancel";
    cancelBtn.addEventListener("click", () => form.remove());

    btnRow.appendChild(saveBtn);
    btnRow.appendChild(cancelBtn);

    form.appendChild(nameRow);
    form.appendChild(descRow);
    form.appendChild(errorEl);
    form.appendChild(btnRow);

    if (existing) {
      const cards = cliToolsList.querySelectorAll(".mcp-card");
      const idx = cliTools.findIndex((t) => t.name === existing.name);
      if (cards[idx]) {
        cards[idx].after(form);
      } else {
        cliToolsList.appendChild(form);
      }
    } else {
      cliToolsList.appendChild(form);
    }

    nameInput.focus();
  }

  cliToolAddBtn.addEventListener("click", () => showCliToolForm());
  const profilesListEl = document.getElementById("profiles-list") as HTMLDivElement | null;
  const profileAddBtn = document.getElementById("profile-add-btn") as HTMLButtonElement | null;

  /** Settings → Profiles list. Renders an editable row per saved profile. */
  function renderProfilesSettings(): void {
    if (!profilesListEl) return;
    profilesListEl.innerHTML = "";
    const state = host.profilesState;
    if (!state || state.profiles.length === 0) {
      const empty = document.createElement("div");
      empty.className = "settings-hint";
      empty.textContent = "No profiles yet. Add one to get started.";
      profilesListEl.appendChild(empty);
      return;
    }

    for (const profile of state.profiles) {
      const isActive = profile.id === state.activeProfileId;
      const row = document.createElement("div");
      row.className = "profile-row" + (isActive ? " active" : "");

      // Tint swatch — tap to generate a new reasonable color (no palette picker).
      const swatch = document.createElement("button");
      swatch.type = "button";
      swatch.className = "profile-swatch";
      swatch.title = "Tap to change the tint color";
      const applySwatch = (tint: string | null) => {
        swatch.style.background = tint && host.isValidTint(tint) ? tint : "";
        swatch.classList.toggle("no-tint", !(tint && host.isValidTint(tint)));
      };
      applySwatch(profile.tint);
      swatch.addEventListener("click", async () => {
        const next = host.generateTintColor(
          profile.tint ? (host.hueOf(profile.tint) ?? undefined) : undefined,
        );
        profile.tint = next;
        applySwatch(next);
        if (isActive) host.applyProfileTint(next);
        await host.whimAPI.updateProfile(profile.id, { tint: next });
      });
      row.appendChild(swatch);

      // Name override — placeholder shows the resolved default (git repo / folder) name.
      const nameInput = document.createElement("input");
      nameInput.type = "text";
      nameInput.className = "profile-name-input";
      nameInput.value = profile.name ?? "";
      nameInput.placeholder = profile.displayName;
      nameInput.spellcheck = false;
      const commitName = async () => {
        const value = nameInput.value.trim();
        const next = value.length > 0 ? value : null;
        if (next === profile.name) return;
        profile.name = next;
        await host.whimAPI.updateProfile(profile.id, { name: next });
      };
      nameInput.addEventListener("blur", () => {
        void commitName();
      });
      nameInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          nameInput.blur();
        }
      });
      row.appendChild(nameInput);

      // Path (muted, click to open in the file manager).
      const pathEl = document.createElement("button");
      pathEl.type = "button";
      pathEl.className = "profile-path";
      const parts = profile.path.replace(/\\/g, "/").split("/");
      pathEl.textContent = parts.length > 2 ? "…/" + parts.slice(-2).join("/") : profile.path;
      pathEl.title = profile.path;
      pathEl.addEventListener("click", () => {
        host.whimAPI.openPath(profile.path);
      });
      row.appendChild(pathEl);

      // Switch button / active badge.
      if (isActive) {
        const badge = document.createElement("span");
        badge.className = "profile-active-badge";
        badge.textContent = "Active";
        row.appendChild(badge);
      } else {
        const switchBtn = document.createElement("button");
        switchBtn.type = "button";
        switchBtn.className = "workspace-btn";
        switchBtn.textContent = "Switch";
        switchBtn.addEventListener("click", async () => {
          const res = await host.whimAPI.activateProfile(profile.id);
          if (!res.ok && res.error === "missing_path") {
            host.showStatus("Profile folder not found", true);
          }
        });
        row.appendChild(switchBtn);
      }

      // Remove.
      const removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.className = "profile-remove-btn";
      removeBtn.title = "Remove profile";
      removeBtn.textContent = "✕";
      removeBtn.addEventListener("click", async () => {
        await host.whimAPI.removeProfile(profile.id);
      });
      row.appendChild(removeBtn);

      profilesListEl.appendChild(row);
    }
  }
  if (profileAddBtn) {
    profileAddBtn.addEventListener("click", () => {
      void host.whimAPI.addProfile();
    });
  }

  // ── CLI Path setting ────────────────────────────────────
  const cliPathInput = document.getElementById("cli-path-input") as HTMLInputElement;
  const cliPathClear = document.getElementById("cli-path-clear") as HTMLButtonElement;
  const cliPathDetected = document.getElementById("cli-path-detected") as HTMLSpanElement;

  /**
   * Synchronous-ish part of CLI path setup — just sets the input value and
   * paints a "checking…" detected-label placeholder. Cheap enough to run
   * eagerly on settings-window init so the General tab renders without
   * waiting on the CLI binary.
   */
  async function loadCliPathInputSync(): Promise<void> {
    const override = await host.whimAPI.getSetting("cli_path");
    cliPathInput.value = override || "";
    cliPathClear.classList.toggle("hidden", !override);
    cliPathDetected.textContent = "Checking…";
    cliPathDetected.title = "";
    cliPathDetected.style.color = "";
    if (cliMxcIndicator) {
      cliMxcIndicator.textContent = "checking…";
      cliMxcIndicator.className = "cli-mxc-indicator";
    }
  }

  /**
   * Run the slow CLI subprocess probes (version check + MXC capability
   * check). Each spawns the CLI binary, so these can take ~200ms each on
   * cold disk caches. Settings-window init defers these to idle so the
   * General tab is interactive immediately.
   */
  async function runCliPathChecks(): Promise<void> {
    await updateCliPathDetected();
    await updateCliMxcIndicator();
  }

  function cliSourceLabel(source: string): string {
    switch (source) {
      case "bundled":
        return "Bundled native stdio";
      case "inprocess":
        return "Bundled in-process (experimental)";
      case "auto":
        return "Auto-detected";
      case "path":
        return "Custom path";
      case "server":
        return "Remote server";
      default:
        return source;
    }
  }

  async function updateCliPathDetected(): Promise<void> {
    const info = await host.whimAPI.getCliRuntimeStatus();
    cliPathDetected.style.color = "";

    if (info.source === "server") {
      cliPathDetected.textContent = info.target
        ? `Remote server — ${info.target}`
        : "Remote server (no URL set)";
      cliPathDetected.title = info.target || "";
      if (!info.target) cliPathDetected.style.color = "var(--color-warning, #d29922)";
      return;
    }

    if (!info.target) {
      cliPathDetected.textContent = "Not found";
      cliPathDetected.title = "";
      return;
    }

    cliPathDetected.title = info.target;
    if (!info.compatible) {
      cliPathDetected.textContent = `${cliSourceLabel(info.source)} (v${info.version || "?"} — update to ${info.minVersion}+) — ${info.target}`;
      cliPathDetected.style.color = "var(--color-warning, #d29922)";
    } else {
      const v = info.version ? ` (v${info.version})` : "";
      cliPathDetected.textContent = `${cliSourceLabel(info.source)}${v} — ${info.target}`;
    }
  }

  const reportSettingsSaveError = (error: unknown) =>
    host.showStatus(error instanceof Error ? error.message : "Settings save failed", true);
  const cliPathSave = new host.DebouncedSave(async () => {
    const val = cliPathInput.value.trim();
    const resolved = await host.whimAPI.setSetting("cli_path", val);
    // Update input to show the resolved full path if it changed
    if (resolved && resolved !== val && cliPathInput.value.trim() === val) {
      cliPathInput.value = resolved;
    }
    cliPathClear.classList.toggle("hidden", !cliPathInput.value);
    void runCliPathChecks().catch(reportSettingsSaveError);
  }, reportSettingsSaveError);
  cliPathInput.addEventListener("input", () => cliPathSave.schedule());

  cliPathClear.addEventListener("click", async () => {
    cliPathInput.value = "";
    await host.whimAPI.setSetting("cli_path", "");
    cliPathClear.classList.add("hidden");
    await updateCliPathDetected();
    await updateCliMxcIndicator();
  });

  // ── Runtime source selector ─────────────────────────────
  const cliSourceSelect = document.getElementById("cli-source-select") as HTMLSelectElement | null;
  const cliPathField = document.getElementById("cli-path-field") as HTMLElement | null;
  const cliPathCustomRow = document.getElementById("cli-path-custom-row") as HTMLElement | null;
  const cliDiscoveredSelect = document.getElementById(
    "cli-discovered-select",
  ) as HTMLSelectElement | null;
  const cliServerFields = document.getElementById("cli-server-fields") as HTMLElement | null;
  const cliInProcessWarning = document.getElementById(
    "cli-inprocess-warning",
  ) as HTMLElement | null;
  const cliServerUrlInput = document.getElementById(
    "cli-server-url-input",
  ) as HTMLInputElement | null;
  const cliServerTokenInput = document.getElementById(
    "cli-server-token-input",
  ) as HTMLInputElement | null;
  const cliTestBtn = document.getElementById("cli-test-btn") as HTMLButtonElement | null;
  const cliRuntimeStatus = document.getElementById("cli-runtime-status") as HTMLSpanElement | null;

  function applyCliSourceVisibility(source: string): void {
    if (cliPathField) cliPathField.hidden = source !== "path";
    if (cliPathCustomRow) {
      cliPathCustomRow.hidden =
        source !== "path" || cliDiscoveredSelect?.value !== host.CLI_CUSTOM_OPTION;
    }
    if (cliServerFields) cliServerFields.hidden = source !== "server";
    if (cliInProcessWarning) cliInProcessWarning.hidden = source !== "inprocess";
  }

  async function loadRuntimeSourceSettings(): Promise<void> {
    if (!cliSourceSelect) return;
    const source = (await host.whimAPI.getSetting("cli_source")) || "bundled";
    cliSourceSelect.value = source;
    if (cliServerUrlInput)
      cliServerUrlInput.value = (await host.whimAPI.getSetting("cli_server_url")) || "";
    if (cliServerTokenInput)
      cliServerTokenInput.value = (await host.whimAPI.getSetting("cli_server_token")) || "";
    // Discovery version-probes candidate binaries, so only run it when the
    // custom-path picker is actually visible.
    if (cliDiscoveredSelect && source === "path") {
      await host.populateCliSelect(cliDiscoveredSelect, cliPathInput.value.trim(), true);
    }
    applyCliSourceVisibility(source);
  }

  cliDiscoveredSelect?.addEventListener("change", async () => {
    const value = cliDiscoveredSelect.value;
    if (cliPathCustomRow) cliPathCustomRow.hidden = value !== host.CLI_CUSTOM_OPTION;
    if (value === host.CLI_CUSTOM_OPTION) {
      cliPathInput.focus();
      return;
    }
    cliPathInput.value = value;
    cliPathClear.classList.toggle("hidden", !value);
    await host.whimAPI.setSetting("cli_path", value);
    await updateCliPathDetected();
    await updateCliMxcIndicator();
  });

  cliSourceSelect?.addEventListener("change", async () => {
    const source = cliSourceSelect.value;
    if (source === "path" && cliDiscoveredSelect) {
      await host.populateCliSelect(cliDiscoveredSelect, cliPathInput.value.trim(), true);
    }
    applyCliSourceVisibility(source);
    if (cliRuntimeStatus) cliRuntimeStatus.textContent = "—";
    await host.whimAPI.setSetting("cli_source", source);
    await updateCliPathDetected();
    await updateCliMxcIndicator();
  });

  const cliServerUrlSave = new host.DebouncedSave(async () => {
    if (cliServerUrlInput)
      await host.whimAPI.setSetting("cli_server_url", cliServerUrlInput.value.trim());
  }, reportSettingsSaveError);
  cliServerUrlInput?.addEventListener("input", () => cliServerUrlSave.schedule());

  const cliServerTokenSave = new host.DebouncedSave(async () => {
    if (cliServerTokenInput)
      await host.whimAPI.setSetting("cli_server_token", cliServerTokenInput.value);
  }, reportSettingsSaveError);
  cliServerTokenInput?.addEventListener("input", () => cliServerTokenSave.schedule());

  cliTestBtn?.addEventListener("click", async () => {
    if (!cliRuntimeStatus) return;
    cliTestBtn.disabled = true;
    cliRuntimeStatus.textContent = "Testing…";
    cliRuntimeStatus.style.color = "";
    try {
      const res = await host.whimAPI.testCliConnection();
      if (res.ok) {
        const v = res.version ? ` v${res.version}` : "";
        cliRuntimeStatus.textContent = `✓ Connected — ${cliSourceLabel(res.source)}${v}`;
        cliRuntimeStatus.style.color = "var(--color-success, #3fb950)";
      } else {
        cliRuntimeStatus.textContent = `✗ ${res.error || "Connection failed"}`;
        cliRuntimeStatus.style.color = "var(--color-danger, #f85149)";
      }
    } catch {
      cliRuntimeStatus.textContent = "✗ Connection failed";
      cliRuntimeStatus.style.color = "var(--color-danger, #f85149)";
    } finally {
      cliTestBtn.disabled = false;
    }
  });

  // ── MXC capability indicator ────────────────────────────
  const cliMxcIndicator = document.getElementById("cli-mxc-indicator") as HTMLSpanElement | null;

  async function updateCliMxcIndicator(): Promise<void> {
    if (!cliMxcIndicator) return;
    try {
      const runtime = await host.whimAPI.getCliRuntimeStatus();
      if (
        runtime.source === "bundled" ||
        runtime.source === "inprocess" ||
        runtime.source === "server"
      ) {
        cliMxcIndicator.textContent =
          runtime.source === "server"
            ? "managed by the remote runtime"
            : "native SDK sandbox; CLI MXC probe does not apply";
        cliMxcIndicator.className = "cli-mxc-indicator";
        return;
      }
      const r = await host.whimAPI.checkCliMxcCapable();
      if (r.mxcCapable) {
        cliMxcIndicator.textContent = "✓ runtime sandbox supported";
        cliMxcIndicator.className = "cli-mxc-indicator ok";
      } else {
        cliMxcIndicator.textContent =
          "⚠ not detected — sandboxed personas will fall back to host-side path enforcement only";
        cliMxcIndicator.className = "cli-mxc-indicator warn";
      }
    } catch {
      cliMxcIndicator.textContent = "?";
      cliMxcIndicator.className = "cli-mxc-indicator";
    }
  }

  // ── Auto-hide side pane setting ──────────────────────────
  const autoHideSidePaneCb = document.getElementById(
    "auto-hide-side-pane-cb",
  ) as HTMLInputElement | null;

  async function loadAutoHideSetting(): Promise<void> {
    if (!autoHideSidePaneCb) return;
    const val = await host.bridgeApi.getSetting("auto_hide_side_pane");
    autoHideSidePaneCb.checked = val !== false; // default true
  }

  if (autoHideSidePaneCb) {
    autoHideSidePaneCb.addEventListener("change", () => {
      host.whimAPI.setSetting("auto_hide_side_pane", String(autoHideSidePaneCb.checked));
    });
  }

  const autoRemoteCb = document.getElementById("auto-remote-cb") as HTMLInputElement | null;

  async function loadAutoRemoteSetting(): Promise<void> {
    if (!autoRemoteCb) return;
    const val = await host.bridgeApi.getSetting("remoteAutoEnable");
    autoRemoteCb.checked = val === true || val === "true";
  }

  if (autoRemoteCb) {
    autoRemoteCb.addEventListener("change", () => {
      host.whimAPI.setSetting("remoteAutoEnable", String(autoRemoteCb.checked));
    });
  }

  // ── Remote Web Access setting ───────────────────────────
  const webRemoteEnabledCb = document.getElementById(
    "web-remote-enabled-cb",
  ) as HTMLInputElement | null;
  const webRemotePortInput = document.getElementById(
    "web-remote-port-input",
  ) as HTMLInputElement | null;
  const webRemoteSaveBtn = document.getElementById(
    "web-remote-save-btn",
  ) as HTMLButtonElement | null;
  const webRemoteRegenerateBtn = document.getElementById(
    "web-remote-regenerate-btn",
  ) as HTMLButtonElement | null;
  const webRemoteTokenInput = document.getElementById(
    "web-remote-token-input",
  ) as HTMLInputElement | null;
  const webRemoteInterfaceList = document.getElementById(
    "web-remote-interface-list",
  ) as HTMLDivElement | null;
  const webRemoteUrlList = document.getElementById("web-remote-url-list") as HTMLDivElement | null;
  const webRemoteQr = document.getElementById("web-remote-qr") as HTMLImageElement | null;
  const webRemoteStatus = document.getElementById("web-remote-status") as HTMLDivElement | null;
  const webRemoteTlsMode = document.getElementById(
    "web-remote-tls-mode",
  ) as HTMLSelectElement | null;
  const webRemoteTlsCustom = document.getElementById(
    "web-remote-tls-custom",
  ) as HTMLDivElement | null;
  const webRemoteTlsCert = document.getElementById(
    "web-remote-tls-cert",
  ) as HTMLInputElement | null;
  const webRemoteTlsKey = document.getElementById("web-remote-tls-key") as HTMLInputElement | null;
  const webRemoteTlsStatus = document.getElementById(
    "web-remote-tls-status",
  ) as HTMLDivElement | null;
  const webRemoteAllowedHosts = document.getElementById(
    "web-remote-allowed-hosts",
  ) as HTMLInputElement | null;
  const webRemoteDeviceList = document.getElementById(
    "web-remote-device-list",
  ) as HTMLDivElement | null;
  const webRemoteActivityList = document.getElementById(
    "web-remote-activity-list",
  ) as HTMLDivElement | null;
  for (const control of [
    webRemotePortInput,
    webRemoteTlsMode,
    webRemoteTlsCert,
    webRemoteTlsKey,
    webRemoteAllowedHosts,
    webRemoteInterfaceList,
  ]) {
    const changed = () => {
      if (webRemoteSaveBtn) host.settingsDrafts.changed(webRemoteSaveBtn);
    };
    control?.addEventListener("input", changed);
    control?.addEventListener("change", changed);
  }

  function setWebRemoteStatus(message: string, error = false): void {
    if (!webRemoteStatus) return;
    webRemoteStatus.textContent = message;
    webRemoteStatus.classList.toggle("web-remote-error", error);
  }

  const SCOPE_WARNINGS: Record<InterfaceScope, string> = {
    loopback: "Only reachable from this machine.",
    private: "Reachable by any device on this local network.",
    vpn: "Reachable by devices on this VPN or tunnel.",
    public: "Warning: this address may be reachable from the public internet.",
  };

  const BINDING_STATE_LABELS: Record<WebRemoteBindingStatus["state"], string> = {
    listening: "Listening",
    pending: "Waiting for interface",
    failed: "Failed",
  };

  /**
   * Selections are keyed by a stable string so the checkbox list can round-trip
   * them without smuggling raw addresses through the DOM. Addresses change; the
   * user's intent shouldn't.
   */
  function selectionKey(selection: WebRemoteBindSelection): string {
    switch (selection.kind) {
      case "interface":
        return `i:${selection.interfaceName}:${selection.family}`;
      case "address":
        return `a:${selection.address}`;
      case "all":
        return `*:${selection.family}`;
    }
  }

  let webRemoteSelectionIndex = new Map<string, WebRemoteBindSelection>();

  function selectedWebRemoteSelections(): WebRemoteBindSelection[] {
    if (!webRemoteInterfaceList) return [];
    return Array.from(
      webRemoteInterfaceList.querySelectorAll<HTMLInputElement>('input[type="checkbox"]:checked'),
    )
      .map((input) => webRemoteSelectionIndex.get(input.value))
      .filter((selection): selection is WebRemoteBindSelection => selection !== undefined);
  }

  /**
   * Build the option list from the union of live interfaces and saved selections,
   * so an interface that is currently down still shows up (checked, pending)
   * rather than silently vanishing from the user's configuration.
   */
  function renderWebRemoteInterfaces(state: WebRemoteState): void {
    if (!webRemoteInterfaceList) return;
    webRemoteInterfaceList.innerHTML = "";
    webRemoteSelectionIndex = new Map();

    const bindingByKey = new Map(
      state.bindings.map((binding) => [selectionKey(binding.selection), binding]),
    );
    const selectedKeys = new Set(state.selections.map(selectionKey));

    type Option = {
      key: string;
      selection: WebRemoteBindSelection;
      label: string;
      scope: InterfaceScope;
    };
    const options: Option[] = [];
    const seen = new Set<string>();

    const push = (selection: WebRemoteBindSelection, label: string, scope: InterfaceScope) => {
      const key = selectionKey(selection);
      if (seen.has(key)) return;
      seen.add(key);
      options.push({ key, selection, label, scope });
    };

    for (const iface of state.interfaces) {
      if (iface.family !== "IPv4") continue;
      const selection: WebRemoteBindSelection =
        iface.scope === "loopback"
          ? { kind: "address", address: iface.address }
          : { kind: "interface", interfaceName: iface.name, family: iface.family };
      push(selection, iface.label, iface.scope);
    }

    for (const selection of state.selections) {
      const binding = bindingByKey.get(selectionKey(selection));
      push(selection, binding?.label ?? describeSelection(selection), binding?.scope ?? "private");
    }

    push({ kind: "all", family: "IPv4" }, "All IPv4 interfaces (0.0.0.0)", "public");

    if (options.length === 0) {
      const empty = document.createElement("div");
      empty.className = "settings-hint";
      empty.textContent = "No network interfaces detected.";
      webRemoteInterfaceList.appendChild(empty);
      return;
    }

    for (const option of options) {
      webRemoteSelectionIndex.set(option.key, option.selection);

      const label = document.createElement("label");
      label.className = "settings-checkbox-label web-remote-interface-option";

      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.value = option.key;
      checkbox.checked = selectedKeys.has(option.key);
      label.appendChild(checkbox);

      const text = document.createElement("span");
      text.textContent = option.label;
      text.title = SCOPE_WARNINGS[option.scope];
      label.appendChild(text);

      const binding = bindingByKey.get(option.key);
      if (binding && state.enabled) {
        const status = document.createElement("span");
        status.className = `web-remote-binding-state web-remote-binding-${binding.state}`;
        status.textContent =
          binding.state === "listening" && binding.addresses.length > 0
            ? `${BINDING_STATE_LABELS[binding.state]} on ${binding.addresses.join(", ")}:${state.port}`
            : `${BINDING_STATE_LABELS[binding.state]} — ${binding.detail}`;
        label.appendChild(status);
      }

      webRemoteInterfaceList.appendChild(label);
    }
  }

  function describeSelection(selection: WebRemoteBindSelection): string {
    switch (selection.kind) {
      case "interface":
        return `${selection.interfaceName} (${selection.family}, not currently available)`;
      case "address":
        return selection.address;
      case "all":
        return `All ${selection.family} interfaces`;
    }
  }

  function renderWebRemoteTls(state: WebRemoteState): void {
    if (webRemoteTlsMode) webRemoteTlsMode.value = state.tls.mode;
    webRemoteTlsCustom?.classList.toggle("hidden", state.tls.mode !== "custom");

    if (!webRemoteTlsStatus) return;
    const loopbackOnly = state.selections.every(
      (selection) =>
        selection.kind === "address" &&
        (selection.address === "127.0.0.1" || selection.address === "::1"),
    );

    if (state.tls.error) {
      webRemoteTlsStatus.textContent = `Certificate error: ${state.tls.error}`;
    } else if (state.tls.active) {
      webRemoteTlsStatus.textContent = state.tls.fingerprint
        ? `HTTPS is on. Certificate fingerprint (SHA-256): ${state.tls.fingerprint}`
        : "HTTPS is on.";
    } else if (state.tls.mode === "auto" && loopbackOnly) {
      webRemoteTlsStatus.textContent =
        "Loopback only, so plain HTTP is used — localhost is already a secure origin.";
    } else if (state.tls.mode === "off") {
      webRemoteTlsStatus.textContent =
        "HTTPS is off. The microphone, clipboard and home-screen install will not work in the browser.";
    } else {
      webRemoteTlsStatus.textContent = "HTTPS is not active yet.";
    }
  }

  function renderWebRemoteDevices(state: WebRemoteState): void {
    if (!webRemoteDeviceList) return;
    webRemoteDeviceList.innerHTML = "";

    if (state.devices.length === 0) {
      const empty = document.createElement("div");
      empty.className = "settings-hint";
      empty.textContent = "No paired browsers yet.";
      webRemoteDeviceList.appendChild(empty);
      return;
    }

    for (const device of state.devices) {
      const row = document.createElement("div");
      row.className = "web-remote-device";

      const name = document.createElement("span");
      name.textContent = device.label;
      row.appendChild(name);

      const meta = document.createElement("span");
      meta.className = "web-remote-device-meta";
      meta.textContent =
        `last seen ${new Date(device.lastSeenAt).toLocaleString()}` +
        (device.lastAddress ? ` from ${device.lastAddress}` : "");
      row.appendChild(meta);

      const revoke = document.createElement("button");
      revoke.className = "workspace-btn";
      revoke.type = "button";
      revoke.textContent = "Revoke";
      revoke.addEventListener("click", async () => {
        renderWebRemoteState(await host.whimAPI.revokeWebRemoteDevice(device.id));
      });
      row.appendChild(revoke);

      webRemoteDeviceList.appendChild(row);
    }
  }

  /**
   * A single `lastError` string told you nothing about what had actually
   * happened over the connection. This is the smallest thing that lets you
   * answer "what has been talking to my machine?".
   */
  function renderWebRemoteActivity(state: WebRemoteState): void {
    if (!webRemoteActivityList) return;
    webRemoteActivityList.innerHTML = "";

    if (state.activity.length === 0) {
      const empty = document.createElement("div");
      empty.className = "settings-hint";
      empty.textContent = "No requests yet.";
      webRemoteActivityList.appendChild(empty);
      return;
    }

    for (const entry of state.activity) {
      const row = document.createElement("div");
      row.className = `web-remote-activity ${entry.outcome}`;

      const when = document.createElement("span");
      when.className = "web-remote-activity-time";
      when.textContent = new Date(entry.at).toLocaleTimeString();
      row.appendChild(when);

      const what = document.createElement("span");
      what.className = "web-remote-activity-what";
      what.textContent = entry.channel ? entry.channel : `${entry.method} ${entry.path}`;
      row.appendChild(what);

      const who = document.createElement("span");
      who.className = "web-remote-activity-who";
      who.textContent = `${entry.identity} · ${entry.remoteAddress}`;
      row.appendChild(who);

      const status = document.createElement("span");
      status.className = "web-remote-activity-status";
      status.textContent = `${entry.status} · ${entry.durationMs}ms`;
      row.appendChild(status);

      webRemoteActivityList.appendChild(row);
    }
  }

  function renderWebRemoteState(state: WebRemoteState): void {
    if (webRemoteSaveBtn && host.settingsDrafts.isDirty(webRemoteSaveBtn)) {
      setWebRemoteStatus("Unapplied remote settings kept. Save them before refreshing.");
      return;
    }
    if (webRemoteEnabledCb) webRemoteEnabledCb.checked = state.enabled;
    if (webRemotePortInput) webRemotePortInput.value = String(state.port);
    if (webRemoteTokenInput) webRemoteTokenInput.value = state.token;
    if (webRemoteTlsCert) webRemoteTlsCert.value = webRemoteTlsCert.value || "";
    if (webRemoteAllowedHosts) webRemoteAllowedHosts.value = state.allowedHosts.join(", ");
    renderWebRemoteInterfaces(state);
    renderWebRemoteTls(state);
    renderWebRemoteDevices(state);
    renderWebRemoteActivity(state);

    if (webRemoteUrlList) {
      webRemoteUrlList.innerHTML = "";
      for (const url of state.urls) {
        const row = document.createElement("div");
        row.className = "web-remote-url";
        row.textContent = url;
        webRemoteUrlList.appendChild(row);
      }
    }

    if (webRemoteQr) {
      if (state.qrDataUrl && state.enabled) {
        webRemoteQr.src = state.qrDataUrl;
        webRemoteQr.classList.remove("hidden");
      } else {
        webRemoteQr.removeAttribute("src");
        webRemoteQr.classList.add("hidden");
      }
    }

    if (!state.enabled) {
      setWebRemoteStatus("Remote web access is off.");
    } else if (state.running) {
      setWebRemoteStatus(
        "Remote web access is running. Scan the QR code to open whim on your phone.",
      );
    } else if (state.bindings.some((binding) => binding.state === "listening")) {
      // Partially bound: serving on what's up, still waiting on the rest.
      const waiting = state.bindings.filter((binding) => binding.state !== "listening");
      setWebRemoteStatus(
        `Running, but ${waiting.length} selected interface${waiting.length === 1 ? "" : "s"} not yet bound: ` +
          waiting.map((binding) => `${binding.label} — ${binding.detail}`).join("; "),
        true,
      );
    } else {
      setWebRemoteStatus(state.error || "Remote web access is enabled but not running.", true);
    }
  }

  async function loadWebRemoteSetting(): Promise<void> {
    if (!webRemoteEnabledCb) return;
    try {
      renderWebRemoteState(await host.whimAPI.getWebRemoteState());
    } catch (err: any) {
      setWebRemoteStatus(err?.message || "Failed to load remote web settings.", true);
    }
  }

  if (webRemoteEnabledCb) {
    webRemoteEnabledCb.addEventListener("change", async () => {
      setWebRemoteStatus(
        webRemoteEnabledCb.checked ? "Starting remote web access…" : "Stopping remote web access…",
      );
      try {
        renderWebRemoteState(await host.whimAPI.setWebRemoteEnabled(webRemoteEnabledCb.checked));
      } catch (err: any) {
        setWebRemoteStatus(err?.message || "Failed to update remote web access.", true);
        await loadWebRemoteSetting();
      }
    });
  }

  if (webRemoteSaveBtn) {
    webRemoteSaveBtn.addEventListener("click", async () => {
      const revision = host.settingsDrafts.revision(webRemoteSaveBtn);
      const port = Number(webRemotePortInput?.value || 0);
      const selections = selectedWebRemoteSelections();
      if (selections.length === 0) {
        setWebRemoteStatus("Select at least one network interface.", true);
        return;
      }
      setWebRemoteStatus("Saving remote web settings…");
      const result = await host.whimAPI.setWebRemoteConfig({
        port,
        selections,
        tlsMode: (webRemoteTlsMode?.value as WebRemoteTlsMode | undefined) ?? undefined,
        tlsCertPath: webRemoteTlsCert?.value.trim(),
        tlsKeyPath: webRemoteTlsKey?.value.trim(),
        allowedHosts: (webRemoteAllowedHosts?.value ?? "")
          .split(",")
          .map((host) => host.trim())
          .filter(Boolean),
      });
      if (!("enabled" in result)) {
        setWebRemoteStatus(result.error, true);
        return;
      }
      if (!host.settingsDrafts.saved(webRemoteSaveBtn, revision)) {
        setWebRemoteStatus("Newer remote settings edits are not saved yet.");
        return;
      }
      renderWebRemoteState(result);
    });
  }

  if (webRemoteRegenerateBtn) {
    webRemoteRegenerateBtn.addEventListener("click", async () => {
      setWebRemoteStatus("Regenerating token and signing out every paired browser…");
      renderWebRemoteState(await host.whimAPI.regenerateWebRemoteToken());
    });
  }

  if (webRemoteTlsMode) {
    webRemoteTlsMode.addEventListener("change", () => {
      webRemoteTlsCustom?.classList.toggle("hidden", webRemoteTlsMode.value !== "custom");
    });
  }

  // ── Comment trigger setting ──────────────────────────────
  const commentHoverCb = document.getElementById("comment-hover-cb") as HTMLInputElement | null;

  async function loadCommentTriggerSetting(): Promise<void> {
    if (!commentHoverCb) return;
    const val = await host.whimAPI.getSetting("comment_trigger");
    commentHoverCb.checked = val === "hover-or-caret";
  }

  if (commentHoverCb) {
    commentHoverCb.addEventListener("change", () => {
      host.whimAPI.setSetting(
        "comment_trigger",
        commentHoverCb.checked ? "hover-or-caret" : "caret",
      );
    });
  }

  // ── Update settings (Settings → General → Updates) ───────
  const updateVersionEl = document.getElementById("update-current-version");
  const updateLineEl = document.getElementById("update-settings-line");
  const updateCheckBtn = document.getElementById("update-check-btn") as HTMLButtonElement | null;
  const updateOpenLogBtn = document.getElementById(
    "update-open-log-btn",
  ) as HTMLButtonElement | null;
  const autoDownloadUpdatesCb = document.getElementById(
    "auto-download-updates-cb",
  ) as HTMLInputElement | null;

  function formatCheckedAt(ts?: number): string {
    if (!ts) return "";
    try {
      return new Date(ts).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
    } catch {
      return "";
    }
  }

  function renderUpdateSettings(state: UpdateState): void {
    if (updateVersionEl) {
      updateVersionEl.textContent = state.currentVersion ? `whim v${state.currentVersion}` : "whim";
    }
    if (updateCheckBtn) {
      updateCheckBtn.disabled = state.status === "checking" || state.status === "downloading";
    }
    if (!updateLineEl) return;

    updateLineEl.classList.remove("update-settings-line--error");
    const checked = state.lastCheckedAt
      ? ` · last checked ${formatCheckedAt(state.lastCheckedAt)}`
      : "";

    switch (state.status) {
      case "disabled":
        updateLineEl.textContent = "Auto-updates run only in the installed app, not in dev builds.";
        break;
      case "checking":
        updateLineEl.textContent = "Checking for updates…";
        break;
      case "available":
        updateLineEl.textContent = `Update available${state.version ? ` (v${state.version})` : ""}.`;
        break;
      case "downloading":
        updateLineEl.textContent = `Downloading update${state.version ? ` (v${state.version})` : ""}… ${state.progress ?? 0}%`;
        break;
      case "downloaded":
        updateLineEl.textContent = `Update ready${state.version ? ` (v${state.version})` : ""} — restart to apply.`;
        break;
      case "up-to-date":
        updateLineEl.textContent = `You're on the latest version${checked}.`;
        break;
      case "error":
        updateLineEl.textContent = `Update check failed${state.error ? `: ${state.error}` : ""}.`;
        updateLineEl.classList.add("update-settings-line--error");
        break;
      case "idle":
      default:
        updateLineEl.textContent = state.lastCheckedAt
          ? `You're on the latest version${checked}.`
          : "Ready.";
        break;
    }
  }

  async function loadUpdateSettings(): Promise<void> {
    if (autoDownloadUpdatesCb) {
      const val = await host.bridgeApi.getSetting("auto_download_updates");
      autoDownloadUpdatesCb.checked = val !== false; // default true
    }
    try {
      renderUpdateSettings(await host.bridgeApi.getUpdateState());
    } catch {
      /* updater not ready yet — the live subscription will fill this in */
    }
  }

  if (updateCheckBtn) {
    updateCheckBtn.addEventListener("click", () => {
      if (updateLineEl) updateLineEl.textContent = "Checking for updates…";
      updateCheckBtn.disabled = true;
      host.bridgeApi.checkForUpdate();
    });
  }

  if (updateOpenLogBtn) {
    updateOpenLogBtn.addEventListener("click", async () => {
      const res = await host.bridgeApi.openUpdateLog();
      if (res && "error" in res && updateLineEl) {
        updateLineEl.textContent = `Couldn't open log: ${res.error}`;
        updateLineEl.classList.add("update-settings-line--error");
      }
    });
  }

  if (autoDownloadUpdatesCb) {
    autoDownloadUpdatesCb.addEventListener("change", () => {
      host.whimAPI.setSetting("auto_download_updates", String(autoDownloadUpdatesCb.checked));
    });
  }

  // Live-update the Updates panel as the main process broadcasts state changes.
  host.bridgeApi.onUpdateStateChanged((state) => {
    renderUpdateSettings(state);
  });

  // ── Settings tabs ───────────────────────────────────────
  const SETTINGS_TAB_KEY = "whim.settingsTab";
  const SETTINGS_TAB_TITLES: Record<string, string> = {
    general: "General",
    environment: "Environment",
    remote: "Remote",
    tools: "Tools",
    personas: "Agents",
    hotkeys: "Hotkeys",
  };
  function initSettingsTabs(): void {
    const tabs = document.querySelectorAll<HTMLButtonElement>(".settings-tab-btn");
    const panels = document.querySelectorAll<HTMLElement>(".settings-tab-panel");
    const titleEl = document.getElementById("settings-active-title");
    if (!tabs.length || !panels.length) return;
    const stored = localStorage.getItem(SETTINGS_TAB_KEY);
    const activate = (name: string) => {
      let matched = false;
      tabs.forEach((t) => {
        const isActive = t.dataset.tab === name;
        t.classList.toggle("active", isActive);
        if (isActive) matched = true;
      });
      panels.forEach((p) => {
        p.classList.toggle("active", p.dataset.tab === name);
      });
      if (matched) {
        if (titleEl) titleEl.textContent = SETTINGS_TAB_TITLES[name] ?? "Settings";
        try {
          localStorage.setItem(SETTINGS_TAB_KEY, name);
        } catch {
          /* ignore */
        }
      }
    };
    tabs.forEach((t) => {
      t.addEventListener("click", () => {
        if (t.dataset.tab) activate(t.dataset.tab);
      });
    });
    if (stored) {
      activate(stored);
    }
    // Fallback: if no tab is active (e.g. stored tab was removed), activate general
    const anyActive = Array.from(tabs).some((t) => t.classList.contains("active"));
    if (!anyActive) activate("general");
  }
  initSettingsTabs();

  const HOTKEY_CATEGORIES: Record<string, string[]> = {
    Global: ["toggleWindow"],
    Canvas: ["canvasPinToTop", "canvasNewPage"],
    Actions: ["popOutWindow", "toggleSearch"],
    Navigation: ["close", "navigateUp", "navigateDown", "openSubmit", "stopRecording"],
  };
  let hotkeyRecordingKey: string | null = null;
  let hotkeyFeedback: { key: string; message: string } | null = null;
  let hotkeyFeedbackTimer: number | null = null;
  const hotkeyCleanupByElement = new WeakMap<HTMLElement, () => void>();

  function setHotkeyFeedback(key: string, message: string): void {
    hotkeyFeedback = { key, message };
    if (hotkeyFeedbackTimer !== null) {
      window.clearTimeout(hotkeyFeedbackTimer);
    }
    hotkeyFeedbackTimer = window.setTimeout(() => {
      if (hotkeyFeedback?.key === key && hotkeyFeedback.message === message) {
        hotkeyFeedback = null;
        hotkeyFeedbackTimer = null;
        renderHotkeysTab();
      }
    }, 3000);
  }

  const hotkeysList = document.getElementById("hotkeys-list") as HTMLDivElement;
  const hotkeysResetAll = document.getElementById("hotkeys-reset-all") as HTMLButtonElement;

  function clearHotkeyFeedback(): void {
    hotkeyFeedback = null;
    if (hotkeyFeedbackTimer !== null) {
      window.clearTimeout(hotkeyFeedbackTimer);
      hotkeyFeedbackTimer = null;
    }
  }

  function renderHotkeysTab(): void {
    hotkeysList.innerHTML = "";
    for (const [category, keys] of Object.entries(HOTKEY_CATEGORIES)) {
      const titleEl = document.createElement("div");
      titleEl.className = "hotkey-group-title";
      titleEl.textContent = category;
      hotkeysList.appendChild(titleEl);

      for (const key of keys) {
        const row = document.createElement("div");
        row.className = "hotkey-row";
        row.dataset.hotkeyKey = key;

        const label = document.createElement("div");
        label.className = "hotkey-label";
        label.textContent = host.HOTKEY_LABELS[key] || key;

        const binding = document.createElement("button");
        binding.className = "hotkey-binding";
        binding.type = "button";
        const accel = host.currentHotkeys[key] || host.DEFAULT_HOTKEYS[key];
        binding.textContent = host.formatAccelerator(accel, host.hotkeyPlatform);
        if (accel !== host.DEFAULT_HOTKEYS[key]) {
          binding.classList.add("modified");
        }
        binding.title = "Click to change";
        binding.setAttribute("aria-label", `Change ${host.HOTKEY_LABELS[key] || key} hotkey`);

        binding.addEventListener("click", () => {
          startHotkeyRecording(key, binding);
        });

        const resetBtn = document.createElement("button");
        resetBtn.className = "hotkey-reset-btn";
        resetBtn.textContent = "↩";
        resetBtn.title = "Reset to default";
        if (accel === host.DEFAULT_HOTKEYS[key]) {
          resetBtn.style.visibility = "hidden";
        }
        resetBtn.addEventListener("click", async (e) => {
          e.stopPropagation();
          await host.whimAPI.resetHotkeys(key);
          host.currentHotkeys[key] = host.DEFAULT_HOTKEYS[key];
          renderHotkeysTab();
        });

        row.appendChild(label);
        row.appendChild(binding);
        row.appendChild(resetBtn);
        if (hotkeyFeedback?.key === key) {
          const feedbackEl = document.createElement("span");
          feedbackEl.className = "hotkey-conflict";
          feedbackEl.textContent = `⚠ ${hotkeyFeedback.message}`;
          row.appendChild(feedbackEl);
        }
        hotkeysList.appendChild(row);
      }
    }
  }

  function startHotkeyRecording(key: string, bindingEl: HTMLElement): void {
    // Cancel any previous recording
    stopRecording_hotkey();
    clearHotkeyFeedback();

    hotkeyRecordingKey = key;
    bindingEl.classList.add("recording");
    bindingEl.textContent = "Press shortcut…";

    const handler = async (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();

      if (e.key === "Escape") {
        stopRecording_hotkey();
        renderHotkeysTab();
        return;
      }

      const accel = host.keyboardEventToAccelerator(e, host.hotkeyPlatform);
      if (!accel) {
        const modifiers = host.modifierEventToAccelerator(e, host.hotkeyPlatform);
        bindingEl.textContent = modifiers
          ? `${host.formatAccelerator(modifiers, host.hotkeyPlatform)}…`
          : "Press shortcut…";
        return;
      }

      const conflict = host.findConflict(accel, key);
      if (conflict) {
        bindingEl.parentElement?.querySelectorAll(".hotkey-conflict").forEach((el) => el.remove());
        bindingEl.classList.remove("recording");
        bindingEl.textContent = host.formatAccelerator(accel, host.hotkeyPlatform);
        // Show conflict warning — block the save, let user try again
        const conflictEl = document.createElement("span");
        conflictEl.className = "hotkey-conflict";
        conflictEl.textContent = `⚠ Conflicts with "${conflict}" — press a different combo`;
        bindingEl.parentElement?.appendChild(conflictEl);
        setTimeout(() => {
          conflictEl.remove();
          // Re-enter recording so user can try again
          bindingEl.classList.add("recording");
          bindingEl.textContent = "Press shortcut…";
        }, 1500);
        return;
      }

      document.removeEventListener("keydown", handler, true);
      await saveHotkeyAndStop(key, accel);
    };

    document.addEventListener("keydown", handler, true);

    // Store cleanup reference
    hotkeyCleanupByElement.set(bindingEl, () => {
      document.removeEventListener("keydown", handler, true);
    });
  }

  async function saveHotkeyAndStop(key: string, accel: string): Promise<void> {
    const result = await host.whimAPI.setHotkey(key, accel);
    if (result.error) {
      setHotkeyFeedback(key, result.error);
    } else {
      clearHotkeyFeedback();
      host.currentHotkeys[key] = accel;
    }
    hotkeyRecordingKey = null;
    renderHotkeysTab();
  }

  function stopRecording_hotkey(): void {
    if (hotkeyRecordingKey) {
      const bindingEl = hotkeysList.querySelector(
        `[data-hotkey-key="${hotkeyRecordingKey}"] .hotkey-binding`,
      ) as HTMLElement | null;
      if (bindingEl) {
        bindingEl.classList.remove("recording");
        hotkeyCleanupByElement.get(bindingEl)?.();
        hotkeyCleanupByElement.delete(bindingEl);
      }
      hotkeyRecordingKey = null;
    }
  }

  hotkeysResetAll.addEventListener("click", async () => {
    await host.whimAPI.resetHotkeys();
    host.currentHotkeys = { ...host.DEFAULT_HOTKEYS };
    renderHotkeysTab();
  });

  // ── Sandbox policy form helpers ─────────────────────────

  function pathListToTextarea(paths: string[]): string {
    return (paths || []).join("\n");
  }

  function textareaToPathList(text: string): string[] {
    return text
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .slice(0, 64);
  }

  /**
   * Render an editable sandbox-policy form into `container`. Returns a
   * `getPolicy()` accessor that reads the current values back as a SandboxPolicy.
   */
  function renderSandboxPolicyForm(
    container: HTMLElement,
    initial: SandboxPolicy,
    opts?: { idPrefix?: string },
  ): { getPolicy: () => SandboxPolicy; setPolicy: (p: SandboxPolicy) => void } {
    const id = (s: string) => `${opts?.idPrefix ?? "sandbox"}-${s}`;
    container.innerHTML = "";

    function checkbox(
      name: string,
      label: string,
      checked: boolean,
      hint?: string,
    ): HTMLInputElement {
      const lbl = document.createElement("label");
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.id = id(name);
      cb.checked = checked;
      lbl.appendChild(cb);
      const span = document.createElement("span");
      span.textContent = label;
      lbl.appendChild(span);
      container.appendChild(lbl);
      if (hint) {
        const h = document.createElement("div");
        h.className = "sandbox-field-hint";
        h.textContent = hint;
        container.appendChild(h);
      }
      return cb;
    }

    function pathTextarea(
      name: string,
      label: string,
      value: string[],
      hint?: string,
    ): HTMLTextAreaElement {
      const title = document.createElement("div");
      title.className = "sandbox-section-title";
      title.textContent = label;
      container.appendChild(title);
      if (hint) {
        const h = document.createElement("div");
        h.className = "sandbox-field-hint";
        h.textContent = hint;
        container.appendChild(h);
      }
      const ta = document.createElement("textarea");
      ta.id = id(name);
      ta.value = pathListToTextarea(value);
      ta.placeholder = "One path per line";
      ta.spellcheck = false;
      container.appendChild(ta);
      return ta;
    }

    // Filesystem section
    const fsTitle = document.createElement("div");
    fsTitle.className = "sandbox-section-title";
    fsTitle.textContent = "Filesystem";
    container.appendChild(fsTitle);

    const scopeBox = checkbox(
      "scope",
      "Read & write inside the space folder",
      initial.scopeToSpaceFolder,
      "When checked, the agent can read and write anywhere inside its space folder. Recommended ON.",
    );
    const rwArea = pathTextarea(
      "rw",
      "Extra read-write paths",
      initial.extraReadwritePaths,
      "Optional. Each line is an absolute path the agent may read AND write.",
    );
    const roArea = pathTextarea(
      "ro",
      "Extra read-only paths",
      initial.extraReadonlyPaths,
      "Optional. Each line is an absolute path the agent may read only.",
    );
    const denyArea = pathTextarea(
      "deny",
      "Denied paths",
      initial.extraDeniedPaths,
      "Optional. Each line is an absolute path the agent must never access (overrides RW/RO).",
    );

    // Tool surface section
    const toolsTitle = document.createElement("div");
    toolsTitle.className = "sandbox-section-title";
    toolsTitle.textContent = "Tool surface";
    container.appendChild(toolsTitle);

    const mcpBox = checkbox(
      "mcp",
      "Allow MCP servers",
      initial.allowMcpServers,
      "When unchecked, sandboxed agents launch with MCP servers hidden. Default OFF.",
    );
    const wfBox = checkbox(
      "web-fetch",
      "Allow web_fetch tool",
      initial.allowWebFetch,
      "When unchecked, sandboxed agents launch without the web_fetch tool. Default OFF.",
    );

    // Network section
    const netTitle = document.createElement("div");
    netTitle.className = "sandbox-section-title";
    netTitle.textContent = "Network (applies to shell sandbox)";
    container.appendChild(netTitle);

    const outBox = checkbox(
      "allow-out",
      "Allow outbound network",
      initial.allowOutbound,
      "When checked, shell commands inside the sandbox may reach the internet (e.g. git fetch). Default OFF.",
    );
    const localBox = checkbox(
      "allow-local",
      "Allow local network",
      initial.allowLocalNetwork,
      "When checked, shell commands may reach localhost / LAN. Default OFF.",
    );

    // Enforcement section — lets the user pick between defense-in-depth (host
    // guards on top of MXC) and MXC-only (test mode that disables host guards
    // so denials come from MXC's AppContainer alone).
    const enforceTitle = document.createElement("div");
    enforceTitle.className = "sandbox-section-title";
    enforceTitle.textContent = "Enforcement";
    container.appendChild(enforceTitle);

    const enforceWrap = document.createElement("label");
    const enforceLbl = document.createElement("span");
    enforceLbl.textContent = "Enforcement mode";
    enforceWrap.appendChild(enforceLbl);
    const enforceSelect = document.createElement("select");
    enforceSelect.id = id("enforcement");
    const optBoth = document.createElement("option");
    optBoth.value = "both";
    optBoth.textContent = "Both: host guards + MXC (Recommended)";
    enforceSelect.appendChild(optBoth);
    const optMxc = document.createElement("option");
    optMxc.value = "mxc-only";
    optMxc.textContent = "MXC only (test mode — host guards disabled)";
    enforceSelect.appendChild(optMxc);
    enforceSelect.value = initial.enforcementMode === "mxc-only" ? "mxc-only" : "both";
    enforceWrap.appendChild(enforceSelect);
    container.appendChild(enforceWrap);

    const enforceHint = document.createElement("div");
    enforceHint.className = "sandbox-field-hint";
    enforceHint.textContent =
      "Both: host-side read-only classifier + path-policy hook deny most things before MXC sees them. " +
      "MXC only: skip those host guards so MXC AppContainer is the sole enforcer for shell commands. " +
      "Use MXC-only to verify MXC is actually doing the work — note that path-bearing SDK tools " +
      "(view/edit/create/glob/grep) are NOT covered by MXC and become unrestricted in this mode.";
    container.appendChild(enforceHint);

    const enforceWarn = document.createElement("div");
    enforceWarn.className = "sandbox-field-hint";
    enforceWarn.style.color = "#c0392b";
    enforceWarn.style.fontWeight = "600";
    enforceWarn.textContent =
      "⚠ MXC-only is a test mode. Use only to verify MXC enforcement; less safe than Both.";
    enforceWarn.style.display = enforceSelect.value === "mxc-only" ? "" : "none";
    container.appendChild(enforceWarn);
    enforceSelect.addEventListener("change", () => {
      enforceWarn.style.display = enforceSelect.value === "mxc-only" ? "" : "none";
    });

    function getPolicy(): SandboxPolicy {
      return {
        scopeToSpaceFolder: scopeBox.checked,
        extraReadwritePaths: textareaToPathList(rwArea.value),
        extraReadonlyPaths: textareaToPathList(roArea.value),
        extraDeniedPaths: textareaToPathList(denyArea.value),
        allowMcpServers: mcpBox.checked,
        allowWebFetch: wfBox.checked,
        allowOutbound: outBox.checked,
        allowLocalNetwork: localBox.checked,
        enforcementMode: enforceSelect.value === "mxc-only" ? "mxc-only" : "both",
      };
    }

    function setPolicy(p: SandboxPolicy): void {
      scopeBox.checked = p.scopeToSpaceFolder;
      rwArea.value = pathListToTextarea(p.extraReadwritePaths);
      roArea.value = pathListToTextarea(p.extraReadonlyPaths);
      denyArea.value = pathListToTextarea(p.extraDeniedPaths);
      mcpBox.checked = p.allowMcpServers;
      wfBox.checked = p.allowWebFetch;
      outBox.checked = p.allowOutbound;
      localBox.checked = p.allowLocalNetwork;
      enforceSelect.value = p.enforcementMode === "mxc-only" ? "mxc-only" : "both";
      enforceWarn.style.display = enforceSelect.value === "mxc-only" ? "" : "none";
    }

    return { getPolicy, setPolicy };
  }
  const panels = startSettings(
    {
      general: [
        loadWorkspaceSetting,
        host.loadThemeSetting,
        loadAutoHideSetting,
        loadUpdateSettings,
        host.refreshProfiles,
        loadExportDestinations,
      ],
      environment: [
        loadModels,
        loadRuntimes,
        loadCliPathInputSync,
        loadRuntimeSourceSettings,
        runCliPathChecks,
      ],
      remote: [loadAutoRemoteSetting, loadWebRemoteSetting],
      tools: [loadMcpServers, loadCliTools],
      personas: [loadPersonas, loadCommentTriggerSetting],
      hotkeys: [host.loadHotkeys],
    },
    (error) => host.showStatus(error, true),
  );
  return {
    refresh: panels.refresh,
    syncThemeControl,
    renderProfilesSettings,
    renderHotkeysTab,
    selectAgent,
    loadPersonas,
    updateWorkspaceDisplay,
    flush: () =>
      Promise.all([cliPathSave.flush(), cliServerUrlSave.flush(), cliServerTokenSave.flush()]),
    hasDirty: () =>
      cliPathSave.hasDirty() || cliServerUrlSave.hasDirty() || cliServerTokenSave.hasDirty(),
  };
}
