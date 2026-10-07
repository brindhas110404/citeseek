import { WorkflowEntrypoint, WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import type { Env, Paper, PaperIngestionParams } from "./types";
import { contentKey, vectorId } from "./types";
import { updatePaper } from "./db";
import { chunkText } from "./utils";
import { embed, indexPaperProfile, summarizePaper } from "./rag";

const RETRY = { retries: { limit: 3, delay: "5 seconds" as const, backoff: "exponential" as const } };
const BATCH = 10;

/**
 * PaperIngestionWorkflow — durable, resumable ingestion.
 *
 *  1. chunk      token-aware, sentence-respecting chunks (deterministic, so recomputed on replay)
 *  2. embed+index per batch: BGE embeddings -> Vectorize, namespaced by paper for scoped search
 *  3. summarize  Llama 3.3 writes a summary, key points and starter questions
 *  4. wait       poll until Vectorize has applied the writes (it indexes asynchronously)
 *  5. finalize   mark the paper ready
 *
 * Each step.do() is checkpointed: if batch 4 of 9 fails, a retry resumes at batch 4.
 */
export class PaperIngestionWorkflow extends WorkflowEntrypoint<Env, PaperIngestionParams> {
  private async updateMeta(paperId: string, patch: Partial<Paper>) {
    await updatePaper(this.env, paperId, patch);
  }

  async run(event: WorkflowEvent<PaperIngestionParams>, step: WorkflowStep): Promise<void> {
    const { paperId, title, autoTitle, titleHint } = event.payload;

    try {
      const content = await this.env.PAPERS_KV.get(contentKey(paperId));
      if (!content) throw new Error("Paper content not found");

      const chunks = chunkText(content);
      const batches = Math.ceil(chunks.length / BATCH);

      for (let b = 0; b < batches; b++) {
        await step.do(`index-batch-${b}`, RETRY, async () => {
          const slice = chunks.slice(b * BATCH, (b + 1) * BATCH);
          const vectors = await embed(this.env, slice);
          await this.env.VECTORIZE.upsert(
            slice.map((text, j) => ({
              id: vectorId(paperId, b * BATCH + j),
              values: vectors[j],
              namespace: paperId,
              metadata: { paperId, title, chunkIndex: String(b * BATCH + j), text },
            }))
          );
          await this.updateMeta(paperId, { stage: `Indexing ${b + 1}/${batches}` });
          return { indexed: slice.length };
        });
      }

      const brief = await step.do("summarize", RETRY, async () => {
        await this.updateMeta(paperId, { stage: autoTitle ? "Reading title & summary" : "Writing summary" });
        try {
          const result = await summarizePaper(this.env, title, content, { detectTitle: autoTitle, titleHint });
          // Show the detected title right away, before the paper finishes indexing.
          if (result.title) await this.updateMeta(paperId, { title: result.title });
          return result;
        } catch (err) {
          // A missing summary shouldn't block Q&A; the paper is still searchable.
          console.warn("Summary failed:", err);
          return { title: undefined, summary: undefined, keyPoints: [], questions: [] };
        }
      });

      // Vectorize applies writes asynchronously. Don't mark the paper ready until a
      // scoped query actually returns it, otherwise the first questions find nothing.
      for (let attempt = 0; attempt < 18; attempt++) {
        const searchable = await step.do(`check-searchable-${attempt}`, async () => {
          await this.updateMeta(paperId, { stage: "Making searchable" });
          const [probe] = await embed(this.env, [chunks[0]]);
          const res = await this.env.VECTORIZE.query(probe, { topK: 1, namespace: paperId });
          return res.matches.length > 0;
        });
        if (searchable) break;
        await step.sleep(`wait-searchable-${attempt}`, "10 seconds");
      }

      // One summary vector per paper, so whole-library questions can pick the right papers fast.
      const profiled = await step.do("index-paper-profile", RETRY, async () => {
        try {
          await indexPaperProfile(this.env, event.payload.userId, { id: paperId, title: brief.title || title, summary: brief.summary, keyPoints: brief.keyPoints });
          return true;
        } catch (err) {
          console.warn("Paper profile failed (it will be retried later):", err);
          return false;
        }
      });

      await step.do("finalize", async () => {
        const { title: detected, ...rest } = brief;
        await this.updateMeta(paperId, {
          ...rest,
          ...(detected ? { title: detected, autoTitle: false } : {}),
          status: "ready",
          stage: undefined,
          paperVec: profiled,
          chunkCount: chunks.length,
        });
        return { status: "ready" };
      });
    } catch (err: any) {
      await this.updateMeta(paperId, {
        status: "failed",
        stage: undefined,
        error: String(err?.message ?? err).slice(0, 300),
      });
      throw err;
    }
  }
}
