// Fakes for Workers AI + Vectorize so the app can be exercised offline.
import { app } from "../src/index";
import { runMaintenance } from "../src/maintenance";
import { PaperIngestionWorkflow } from "../src/workflow";
import type { Env } from "../src/types";
export { ChatSession } from "../src/chat-session";

const DIM = 768;
const words = (s: string) => s.toLowerCase().match(/[a-z]{3,}/g) ?? [];
function hashEmbed(s: string): number[] {
  const v = new Array(DIM).fill(0);
  for (const w of words(s)) {
    let h = 2166136261;
    for (const ch of w) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
    v[Math.abs(h) % DIM] += 1;
  }
  const n = Math.hypot(...v) || 1;
  return v.map((x) => x / n);
}
const cos = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i], 0);

function sse(tokens: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    async start(ctrl) {
      for (const t of tokens) {
        ctrl.enqueue(enc.encode(`data: ${JSON.stringify({ response: t })}\n\n`));
        await new Promise((r) => setTimeout(r, 15));
      }
      ctrl.enqueue(enc.encode("data: [DONE]\n\n"));
      ctrl.close();
    },
  });
}

function withMocks(env: Env): Env {
  const kv = env.PAPERS_KV;
  const AI = {
    async run(model: string, input: any) {
      if (model.includes("bge-base")) return { data: input.text.map(hashEmbed) };
      if (model.includes("reranker")) {
        const q = new Set(words(input.query));
        return {
          response: input.contexts
            .map((c: any, id: number) => ({ id, score: words(c.text).filter((w) => q.has(w)).length }))
            .sort((a: any, b: any) => b.score - a.score)
            .slice(0, input.top_k),
        };
      }
      if (model.includes("8b")) {
        const last = input.messages.at(-1).content.split("Latest question: ")[1] ?? "";
        return { response: `${last} (standalone)` };
      }
      if (input.stream) {
        const answer =
          "The **Transformer** relies entirely on attention, dispensing with recurrence [1]. " +
          "It uses multi-head attention so the model can attend to information from different representation subspaces [2].\n\n" +
          "- Encoder and decoder are stacks of 6 identical layers [1]\n- Training was faster than recurrent models [3]\n\nOverall it set a new state of the art in translation [brief].";
        return sse(answer.match(/\S+\s*/g)!);
      }
      return {
        response: JSON.stringify({
          title: "Attention Is All You Need",
          summary: "Introduces the Transformer, a sequence model built only on attention. It trains faster and beats prior translation results.",
          keyPoints: ["Removes recurrence and convolutions entirely", "Multi-head self-attention captures long-range dependencies", "New state of the art on WMT 2014 translation"],
          questions: ["What is multi-head attention?", "Why use positional encodings?", "How long did training take?", "How does it compare to RNNs?"],
        }),
      };
    },
  };
  const VECTORIZE = {
    async upsert(vs: any[]) {
      for (const v of vs) await kv.put(`__vec:${v.namespace ?? ""}:${v.id}`, JSON.stringify(v));
      return { mutationId: "m" };
    },
    async query(vec: number[], opts: any) {
      const list = await kv.list({ prefix: `__vec:${opts.namespace ? opts.namespace + ":" : ""}` });
      const vs = await Promise.all(list.keys.map(async (k) => JSON.parse((await kv.get(k.name))!)));
      const matches = vs
        .map((v) => ({ id: v.id, score: 0.5 + cos(vec, v.values) / 2, metadata: v.metadata }))
        .sort((a, b) => b.score - a.score)
        .slice(0, opts.topK);
      return { matches, count: matches.length };
    },
    async deleteByIds(ids: string[]) {
      const list = await kv.list({ prefix: "__vec:" });
      for (const k of list.keys) if (ids.some((id) => k.name.endsWith(":" + id))) await kv.delete(k.name);
      return { mutationId: "m" };
    },
  };
  return { ...env, AI: AI as any, VECTORIZE: VECTORIZE as any };
}

export class MockIngestionWorkflow extends PaperIngestionWorkflow {
  constructor(ctx: any, env: Env) {
    super(ctx, withMocks(env));
  }
}

export default {
  fetch(req: Request, env: Env, ctx: ExecutionContext) {
    return app.fetch(req, withMocks(env), ctx);
  },
  scheduled(_e: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runMaintenance(withMocks(env)));
  },
};
