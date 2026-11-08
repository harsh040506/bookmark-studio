/**
 * The index takes writes, and taking them must not change what it answers.
 *
 * ## What these tests are actually protecting
 *
 * The whole point of making the index incremental was to stop rebuilding it eight times per
 * interaction. The risk that introduces is subtle and would be very hard to notice in use:
 * an index that is *nearly* right. Document frequency drifts by one, a posting list keeps an
 * id that no longer contains the term, a cached norm outlives the corpus change that
 * invalidated it — and the symptom is not an error, it is search results that are slightly
 * wrong in a way nobody can reproduce.
 *
 * So the property under test throughout is equivalence: after any sequence of writes, the
 * incremental index must answer exactly as a freshly-built one over the same documents. That
 * is the only assertion strong enough to catch the failure mode.
 */
import { describe, expect, it } from "vitest";
import { TfIdfIndex, type IndexDoc } from "../tfidf";
import { countDoc, type RawDoc } from "../index.worker";

const docs: IndexDoc[] = [
  { id: "a", terms: ["design", "design", "figma", "tool"] },
  { id: "b", terms: ["design", "system", "token"] },
  { id: "c", terms: ["rust", "compiler", "tool"] },
  { id: "d", terms: ["figma", "plugin", "design"] },
];

/** Scores rounded, because equivalence is about the ranking rather than about float bits. */
function ranked(index: TfIdfIndex, terms: string[]): string[] {
  return index.search(terms).map((hit) => hit.id);
}

describe("an index that takes writes", () => {
  it("answers identically to one built from scratch", () => {
    const built = new TfIdfIndex(docs);

    const incremental = new TfIdfIndex();
    for (const doc of docs) incremental.add(doc);

    expect(ranked(incremental, ["design"])).toEqual(ranked(built, ["design"]));
    expect(ranked(incremental, ["tool"])).toEqual(ranked(built, ["tool"]));
    expect(incremental.vocabulary().sort()).toEqual(built.vocabulary().sort());
  });

  it("matches a fresh build after a removal", () => {
    const incremental = new TfIdfIndex(docs);
    incremental.remove("b");

    const built = new TfIdfIndex(docs.filter((doc) => doc.id !== "b"));

    expect(ranked(incremental, ["design"])).toEqual(ranked(built, ["design"]));
    expect(incremental.size).toBe(built.size);
    expect(incremental.has("b")).toBe(false);
  });

  it("matches a fresh build after a document is replaced", () => {
    const replacement: IndexDoc = { id: "a", terms: ["rust", "rust", "async"] };

    const incremental = new TfIdfIndex(docs);
    incremental.update(replacement);

    const built = new TfIdfIndex(docs.map((doc) => (doc.id === "a" ? replacement : doc)));

    expect(ranked(incremental, ["rust"])).toEqual(ranked(built, ["rust"]));
    // The decisive one: "figma" was only in `a` and `d`, and `a` no longer has it. An
    // incremental update that forgot to prune postings would still return `a` here.
    expect(ranked(incremental, ["figma"])).toEqual(ranked(built, ["figma"]));
    expect(ranked(incremental, ["figma"])).not.toContain("a");
  });

  it("forgets a term whose last document has gone", () => {
    const index = new TfIdfIndex(docs);
    // "compiler" exists only in `c`.
    expect(index.vocabulary()).toContain("compiler");
    index.remove("c");
    // A vocabulary that kept it would offer the spelling corrector a word that leads to an
    // empty result — the one correction worse than no correction.
    expect(index.vocabulary()).not.toContain("compiler");
    expect(index.search(["compiler"])).toEqual([]);
  });

  it("applies a batch with the same result as one-by-one", () => {
    const stepwise = new TfIdfIndex(docs);
    stepwise.remove("a");
    stepwise.add({ id: "e", terms: ["design", "motion"] });

    const batched = new TfIdfIndex(docs);
    batched.bulk({ remove: ["a"], add: [{ id: "e", terms: ["design", "motion"] }] });

    expect(ranked(batched, ["design"])).toEqual(ranked(stepwise, ["design"]));
    expect(batched.size).toBe(stepwise.size);
  });

  it("keeps `similar` consistent after edits", () => {
    const index = new TfIdfIndex(docs);
    const before = index.similar("a", 5).map((hit) => hit.id);
    expect(before).toContain("d");

    // `d` loses everything it shared with `a`.
    index.update({ id: "d", terms: ["postgres", "index"] });
    expect(index.similar("a", 5).map((hit) => hit.id)).not.toContain("d");
  });
});

describe("counting off the main thread", () => {
  /**
   * The worker exists to move tokenising, not to change it.
   *
   * A divergence here would show up as search results that differ depending on library
   * size — since the worker is only used above a threshold — which is close to impossible
   * to diagnose from a bug report.
   */
  it("produces the same index as tokenising here", () => {
    const raw: RawDoc[] = [
      { id: "a", texts: ["Design systems at Figma", "Design systems at Figma"], domains: ["figma.com"] },
      { id: "b", texts: ["The Rust compiler explained"], domains: ["rust-lang.org"] },
    ];

    const viaWorker = TfIdfIndex.fromCounts(raw.map(countDoc));

    const viaMain = new TfIdfIndex(
      raw.map((doc) => {
        const counted = countDoc(doc);
        const terms: string[] = [];
        for (let index = 0; index < counted.terms.length; index += 1) {
          for (let repeat = 0; repeat < counted.counts[index]; repeat += 1) {
            terms.push(counted.terms[index]);
          }
        }
        return { id: doc.id, terms };
      }),
    );

    expect(viaWorker.vocabulary().sort()).toEqual(viaMain.vocabulary().sort());
    expect(ranked(viaWorker, ["design"])).toEqual(ranked(viaMain, ["design"]));
    expect(ranked(viaWorker, ["rust"])).toEqual(ranked(viaMain, ["rust"]));
  });

  it("counts repeated terms rather than repeating them", () => {
    const counted = countDoc({
      id: "a",
      texts: ["design design design"],
      domains: [],
    });
    const position = counted.terms.indexOf("design");
    expect(position).toBeGreaterThanOrEqual(0);
    expect(counted.counts[position]).toBe(3);
    // The whole reason for the shape: one string crosses the boundary, not three.
    expect(counted.terms.filter((term) => term === "design")).toHaveLength(1);
  });
});
