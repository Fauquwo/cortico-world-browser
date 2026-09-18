/** World 测试共用的假宿主：记录即时事件、投递选项与延迟渲染项，其余宿主接口都是空实现。 */
import type { DeferredEventSpec, EventEnvelope, PushOptions, TriggerMode, WorldHost } from 'cortico/core/types.ts';

/** 延迟渲染项里我们关心的部分。 */
export type DeferredSpec = Pick<DeferredEventSpec, 'type' | 'tags' | 'render'>;

export class FakeHost implements WorldHost {
  events: EventEnvelope[] = [];
  store = {
    get: () => undefined,
    latestCursor: () => 0,
    range: () => [],
    around: () => [],
    grep: () => [],
  } as unknown as WorldHost['store'];
  blob = (_handle: string): { bytes: Uint8Array; mime: string } | null => null;
  modelFacts = { model: () => 'test', accepts: () => false, contextWindow: () => 128000 };
  log = {
    child() {
      return this;
    },
    info() {},
    warn() {},
    error() {},
    debug() {},
    trace() {},
    emit() {},
  } as unknown as WorldHost['log'];

  /** 与 events 逐条对齐：唤醒/攒批的口径也要能断言 */
  pushOpts: Array<PushOptions | undefined> = [];

  /** 挂上的延迟渲染项；投递时才渲染，所以由用例显式渲染。 */
  deferred: Array<{ spec: DeferredSpec; trigger?: TriggerMode }> = [];

  async pushEvent(e: Omit<EventEnvelope, 'cursor'>, opts?: PushOptions): Promise<EventEnvelope> {
    const full = { ...e, cursor: this.events.length + 1 } as EventEnvelope;
    this.events.push(full);
    this.pushOpts.push(opts);
    return full;
  }

  pushDeferred(spec: DeferredSpec, opts?: { trigger?: TriggerMode }): void {
    this.deferred.push({ spec, ...(opts?.trigger ? { trigger: opts.trigger } : {}) });
  }

  /** 渲染并清空挂着的项，返回其中有正文的那些（render 返回 null 的按投递规则丢弃）。 */
  async renderDeferred(): Promise<string[]> {
    const pending = this.deferred;
    this.deferred = [];
    const out: string[] = [];
    for (const item of pending) {
      const rendered = await item.spec.render();
      if (typeof rendered === 'string' && rendered !== '') out.push(rendered);
      else if (rendered && typeof rendered === 'object' && rendered.text !== '') out.push(rendered.text);
    }
    return out;
  }

  async drainPendingEvents(): Promise<EventEnvelope[]> {
    return [];
  }
  reportUsage(): void {}
}
