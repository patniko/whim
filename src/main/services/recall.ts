import { listSpaces } from '../storage';
import { findSimilarSpace } from '../ai';
import { notifyAllWindows } from '../notify';

export async function searchForRecall(spaceId: string, description: string): Promise<void> {
  try {
    const allSpaces = (await listSpaces());
    // Exclude the space itself, get recent ones (last 30)
    const candidates = allSpaces
      .filter(i => i.id !== spaceId)
      .slice(0, 30);

    if (candidates.length === 0) return;

    // Prefilter: simple word overlap scoring to narrow to top 8
    const words = new Set(description.toLowerCase().split(/\s+/).filter(w => w.length > 2));
    const scored = candidates.map(c => {
      const cWords = (c.description || '').toLowerCase().split(/\s+/);
      const overlap = cWords.filter(w => words.has(w)).length;
      return { space: c, overlap };
    });
    scored.sort((a, b) => b.overlap - a.overlap);
    const topCandidates = scored.slice(0, 8).map(s => s.space);

    if (topCandidates.length === 0) return;

    const match = await findSimilarSpace(description, topCandidates);
    if (match) {
      notifyAllWindows('space:recall', spaceId, match);
    }
  } catch (err) {
    console.error('[recall] Search failed:', err);
  }
}
