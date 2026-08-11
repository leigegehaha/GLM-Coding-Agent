type WebConsoleEventPublisher = (topic: string, payload: unknown) => void;

let eventPublisher: WebConsoleEventPublisher | null = null;

/** 注册 Web 控制台事件出口，避免业务模块直接依赖本地 HTTP 服务实例。 */
export const setWebConsoleEventPublisher = (publisher: WebConsoleEventPublisher): void => {
  eventPublisher = publisher;
};

/** 将主进程业务事件转发给当前已配对的 Web 客户端。 */
export const publishWebConsoleEvent = (topic: string, payload: unknown): void => {
  eventPublisher?.(topic, payload);
};
