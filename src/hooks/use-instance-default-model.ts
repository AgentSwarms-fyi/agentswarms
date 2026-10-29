// The instance default model (Admin → Developer runtime → AI services →
// Default model), for forms that start a new thing with a model already
// chosen and for pickers that name what "no choice" runs on.
import { useEffect, useState } from "react";
import {
  getInstanceProviderStatus,
  type InstanceProviderStatus,
} from "@/utils/providers/instanceProviders.functions";

export type InstanceDefaultModel = InstanceProviderStatus["defaultModel"];

let cached: Promise<InstanceDefaultModel | null> | null = null;

function load(): Promise<InstanceDefaultModel | null> {
  cached ??= getInstanceProviderStatus()
    .then((s) => s.defaultModel ?? null)
    .catch(() => {
      cached = null; // try again next time rather than remembering a failure
      return null;
    });
  return cached;
}

export function useInstanceDefaultModel(): InstanceDefaultModel | null {
  const [value, setValue] = useState<InstanceDefaultModel | null>(null);
  useEffect(() => {
    let live = true;
    void load().then((v) => {
      if (live) setValue(v);
    });
    return () => {
      live = false;
    };
  }, []);
  return value;
}
