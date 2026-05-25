import {
  EventCallback,
  EventName,
  listen,
  type UnlistenFn,
  Options,
} from "@tauri-apps/api/event";
import { useRef, useEffect, useCallback } from "react";

interface ListenerOptions extends Options {
  unregisterOnEvent?: boolean;
}

export function useTauriEventListener<T>(
  event: EventName,
  handler: EventCallback<T>,
  options: ListenerOptions,
) {
  const unlistenRef = useRef<UnlistenFn | null>(null);

  const { unregisterOnEvent, ...tauriOptions } = options;

  const registerListener = useCallback(() => {
    unregisterListener();
    listen<T>(
      event,
      (e) => {
        if (unregisterOnEvent) unregisterListener();
        handler(e);
      },
      tauriOptions,
    ).then((unlisten) => {
      unlistenRef.current = unlisten;
    });
  }, []);

  const unregisterListener = useCallback(() => {
    unlistenRef.current?.();
    unlistenRef.current = null;
  }, []);

  // cleanup on unmount
  useEffect(() => {
    return () => {
      unregisterListener();
    };
  }, []);

  return {
    registerListener,
    unregisterListener,
  };
}
