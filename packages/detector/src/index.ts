export { createDetector } from "./matcher.js";
export { classifyReferral } from "./referral.js";
export type { AiReferralSource } from "./referral.js";
export type { Classification, Detector, DetectorOptions } from "./types.js";
export { createIpVerifier } from "./verify/verifier.js";
export type {
  DnsResolverLike,
  IpVerifier,
  IpVerifierOptions,
  VerificationStatus
} from "./verify/verifier.js";
export { RangeSet, extractCidrs, parseCidr, parseIp } from "./verify/cidr.js";
export type { IpRange, ParsedIp } from "./verify/cidr.js";
