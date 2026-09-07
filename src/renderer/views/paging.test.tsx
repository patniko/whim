// @vitest-environment happy-dom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { PageControls } from "./PageControls";
import { VirtualRows } from "./VirtualRows";

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("bounded list navigation", () => {
  it("anchors variable-height prepends using stable IDs rather than page indices", async () => {
    const scroll = document.documentElement;
    scroll.scrollTop = 0;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.getAttribute("role") === "list") return new DOMRect(0, -scroll.scrollTop, 400, 100000);
      if (this.getAttribute("role") === "listitem") {
        return new DOMRect(0, Number.parseFloat(this.style.top) - scroll.scrollTop, 400,
          31 + Number(this.dataset.virtualId?.replace("row-", "")) % 9 * 12);
      }
      return new DOMRect();
    });
    let rows = Array.from({ length: 1000 }, (_, n) => ({ id: `row-${n}` }));
    const render = () => root.render(<VirtualRows rows={rows} rowId={row => row.id} render={row => <button>{row.id}</button>} />);
    act(render);
    scroll.scrollTop = 15000;
    await act(async () => {
      window.dispatchEvent(new Event("scroll"));
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    });
    const anchor = [...host.querySelectorAll<HTMLElement>("[data-virtual-id]")]
      .find(node => node.getBoundingClientRect().top >= 0)!;
    const id = anchor.dataset.virtualId;
    const before = anchor.getBoundingClientRect().top;
    rows = [...Array.from({ length: 10 }, (_, n) => ({ id: `row-${1000 + n}` })), ...rows];
    act(render);
    expect(host.querySelector<HTMLElement>(`[data-virtual-id="${id}"]`)?.getBoundingClientRect().top).toBe(before);
    scroll.scrollTop = 0;
  });
  it("virtualizes ordinary rows while retaining the selected global row", () => {
    const rows = Array.from({ length: 10000 }, (_, i) => ({ id: String(i) }));
    act(() =>
      root.render(
        <VirtualRows
          rows={rows}
          rowId={(row) => row.id}
          selectedIndex={9999}
          total={10000}
          render={(row) => <button>{row.id}</button>}
        />,
      ),
    );
    expect(host.querySelectorAll("[role=listitem]").length).toBeLessThan(100);
    expect(host.querySelector('[data-virtual-id="9999"]')).not.toBeNull();
    expect(host.querySelector('[aria-setsize="10000"]')).not.toBeNull();
  });
  it("loads only the requested page and preserves retryable failures", async () => {
    let resolve!: () => void;
    const load = vi.fn(
      () =>
        new Promise<void>((done) => {
          resolve = done;
        }),
    );
    act(() =>
      root.render(
        <PageControls nextCursor="next" total={1000} count={60} scope="spaces" load={load} />,
      ),
    );
    expect(load).not.toHaveBeenCalled();
    await act(async () => {
      host.querySelectorAll("button")[1].click();
      host.querySelectorAll("button")[1].click();
    });
    expect(load).toHaveBeenCalledExactlyOnceWith("next");
    await act(async () => resolve());
    load.mockRejectedValueOnce(new Error("Unavailable"));
    await act(async () => host.querySelectorAll("button")[0].click());
    expect(host.querySelector("[role=alert]")?.textContent).toBe("Unavailable");
    expect(host.textContent).toContain("1000 total");
    expect(host.querySelectorAll("button")[0].disabled).toBe(false);
  });
  it("uses global row ordinals on later pages", () => {
    act(() =>
      root.render(
        <VirtualRows
          rows={[{ id: "later" }]}
          rowId={(row) => row.id}
          offset={60}
          total={1000}
          render={(row) => <button>{row.id}</button>}
        />,
      ),
    );
    expect(host.querySelector("[role=listitem]")?.getAttribute("aria-posinset")).toBe("61");
  });
  it("tracks the browser window when the document is the scroll parent", async () => {
    const rows = Array.from({ length: 1000 }, (_, i) => ({ id: String(i) }));
    act(() =>
      root.render(
        <VirtualRows
          rows={rows}
          rowId={(row) => row.id}
          render={(row) => <button>{row.id}</button>}
        />,
      ),
    );
    const list = host.querySelector<HTMLElement>("[role=list]")!;
    vi.spyOn(list, "getBoundingClientRect").mockReturnValue(new DOMRect(0, -10000));
    await act(async () => {
      window.dispatchEvent(new Event("scroll"));
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    });
    expect(host.querySelector('[data-virtual-id="0"]')).toBeNull();
    expect(host.querySelectorAll("[role=listitem]").length).toBeLessThan(100);
    expect(list.style.flexShrink).toBe("0");
  });
});
