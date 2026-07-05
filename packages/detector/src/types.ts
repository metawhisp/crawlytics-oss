import type { ActorType } from "@crawlytics/registry";

export interface Classification {
  actorType: ActorType;
  botId?: string;
  operator?: string;
}

export interface DetectorOptions {
  /** Max number of memoized UA strings (LRU). 0 disables the cache. Default 5000. */
  cacheSize?: number;
}

export interface Detector {
  classify(userAgent: string | null | undefined): Classification;
}
