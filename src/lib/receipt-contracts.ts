/**
 * The trust anchor a receipt chains to — `/v1/info#builder`, verbatim.
 * Snapshotted alongside each stored receipt so verification stays offline and
 * an exported bundle is self-verifying by a third party.
 */
export interface ReceiptTrustAnchor {
  /** Builder identity x-only pubkey (64 hex). */
  pubkey: string;
  /** Deploy-time attestation payload, as served. */
  attestation: Record<string, unknown>;
  /** BIP-340 signature over the attestation, under {@link pubkey}. */
  signature: string;
}

/**
 * What one live `/v1/info` read learned about an endpoint's trust anchor.
 *
 * The two ways to come back without an anchor are different facts and must not
 * collapse into one: a DVM that answered and published no `builder` block has
 * told us it has none, while a DVM we could not reach has told us nothing. A
 * caller holding a previously pinned anchor needs them apart before it decides
 * whether to drop it.
 */
export interface TrustAnchorRead {
  /** `true` when `/v1/info` answered — so an absent {@link anchor} is the DVM's own word. */
  reachable: boolean;
  /** The anchor as served. Absent when the DVM publishes none, or when unreachable. */
  anchor?: ReceiptTrustAnchor;
}
