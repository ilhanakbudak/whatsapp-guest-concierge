export type GuestRole = "guest" | "admin";
export type MessageDirection = "inbound" | "outbound";
export type BroadcastStatus = "queued" | "running" | "completed" | "failed";
export type RecipientStatus =
  | "queued"
  | "sending"
  | "sent"
  | "delivered"
  | "read"
  | "failed"
  | "undelivered";

export interface Guest {
  id: number;
  phone: string;
  name: string;
  role: GuestRole;
  active: boolean;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Message {
  id: number;
  guestId: number | null;
  phone: string;
  direction: MessageDirection;
  body: string;
  twilioSid: string | null;
  createdAt: string;
}

export interface ConversationTurn {
  role: "user" | "assistant";
  content: string;
  at: string;
}

export interface Broadcast {
  id: number;
  body: string;
  createdBy: string;
  status: BroadcastStatus;
  createdAt: string;
  completedAt: string | null;
}

export interface BroadcastRecipient {
  id: number;
  broadcastId: number;
  guestId: number;
  phone: string;
  status: RecipientStatus;
  twilioSid: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  attempts: number;
  updatedAt: string;
}

export interface UsageEvent {
  id: number;
  kind: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  guestId: number | null;
  createdAt: string;
}
