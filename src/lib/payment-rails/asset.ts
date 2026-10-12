/** Dependency-free display names for the token selected by a stablecoin rail. */
export interface RailAsset {
  /** Token contract the rail settles in. */
  address: `0x${string}`;
  /** Ticker when the contract is one we can name; null when it isn't. */
  symbol: string | null;
  /** Sentence form ("send only <label>"): the name, else a generic descriptor. */
  label: string;
  /** Quantity form ("1.50 <unit>"): the ticker, else a generic noun. */
  unit: string;
}
