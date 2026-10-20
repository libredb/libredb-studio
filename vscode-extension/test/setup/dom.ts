import { GlobalRegistrator } from "@happy-dom/global-registrator";

/**
 * Registers happy-dom's globals for the calling describe block only, and IS_REACT_ACT_ENVIRONMENT; unregisters after it.
 * Call it at the top of a describe block, so no host or backend test ever sees a DOM global.
 */
export function useDom(url = "http://localhost/"): void {
  before(() => {
    GlobalRegistrator.register({ url });
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });
  after(async () => {
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
    await GlobalRegistrator.unregister();
  });
}
