// Typed client over a Transport.

import type { ProviderId } from "@oneseat/contracts";
import {
  EVENT_NOTIFICATION,
  EVENT_STATUS,
  isUiMethod,
  SHELL_ERRORS,
  type DaemonNotification,
  type DaemonStatus,
  type ExportResult,
  type KeyStatus,
  type Params,
  type PinOpenResult,
  type Result,
  type UiMethod,
} from "./protocol";
import { ShellError, type Transport, type Unlisten } from "./transport";

export class Api {
  constructor(readonly transport: Transport) {}

  /** Call a daemon method through the shell (`daemon_call`). */
  call<M extends UiMethod>(method: M, params: Params<M>): Promise<Result<M>> {
    if (!isUiMethod(method)) {
      return Promise.reject(new ShellError(`the method "${String(method)}" cannot be called from the UI`, SHELL_ERRORS.forbidden));
    }
    return this.transport.invoke<Result<M>>("daemon_call", { method, params });
  }

  keySave(provider: ProviderId, apiKey: string, baseUrl?: string): Promise<KeyStatus> {
    return this.transport.invoke<KeyStatus>("key_save", { provider, apiKey, baseUrl: baseUrl || null });
  }

  keyDelete(provider: ProviderId): Promise<KeyStatus> {
    return this.transport.invoke<KeyStatus>("key_delete", { provider });
  }

  keyStatus(): Promise<KeyStatus> {
    return this.transport.invoke<KeyStatus>("key_status");
  }

  daemonStatus(): Promise<DaemonStatus> {
    return this.transport.invoke<DaemonStatus>("daemon_status");
  }

  pinOpen(appId: string): Promise<PinOpenResult | null> {
    return this.transport.invoke<PinOpenResult | null>("pin_open", { appId });
  }

  appExport(appId: string): Promise<ExportResult> {
    return this.transport.invoke<ExportResult>("app_export", { appId });
  }

  onNotification(handler: (n: DaemonNotification) => void): Promise<Unlisten> {
    return this.transport.listen<DaemonNotification>(EVENT_NOTIFICATION, handler);
  }

  onStatus(handler: (s: DaemonStatus) => void): Promise<Unlisten> {
    return this.transport.listen<DaemonStatus>(EVENT_STATUS, handler);
  }
}

/** A sentence for an error, for status lines and alerts. */
export function describeError(e: unknown): string {
  if (e instanceof ShellError) {
    switch (e.code) {
      case SHELL_ERRORS.daemonUnavailable:
        return `OneSeat's engine is not available right now: ${e.message}`;
      case SHELL_ERRORS.timeout:
        return "OneSeat's engine took too long to answer. Try again.";
      case -32001:
        return `Not authorised: ${e.message}. Check your model key in Setup.`;
      default:
        return e.message;
    }
  }
  return e instanceof Error ? e.message : String(e);
}
