export interface KnowledgeBaseSnapshot {
  content: string;
  /** Stable hash of the content, so an unchanged source can short-circuit. */
  hash: string;
  fetchedAt: Date;
}

export interface KnowledgeBaseProvider {
  readonly source: string;
  fetch(): Promise<KnowledgeBaseSnapshot>;
}
