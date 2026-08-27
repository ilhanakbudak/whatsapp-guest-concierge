import type { Db } from "../index.js";
import { BroadcastsRepository } from "./broadcasts.js";
import { ConversationsRepository } from "./conversations.js";
import { GuestsRepository } from "./guests.js";
import { MessagesRepository } from "./messages.js";
import { UsageRepository } from "./usage.js";

export interface Repositories {
  guests: GuestsRepository;
  messages: MessagesRepository;
  conversations: ConversationsRepository;
  broadcasts: BroadcastsRepository;
  usage: UsageRepository;
}

export function createRepositories(db: Db): Repositories {
  return {
    guests: new GuestsRepository(db),
    messages: new MessagesRepository(db),
    conversations: new ConversationsRepository(db),
    broadcasts: new BroadcastsRepository(db),
    usage: new UsageRepository(db),
  };
}

export {
  BroadcastsRepository,
  ConversationsRepository,
  GuestsRepository,
  MessagesRepository,
  UsageRepository,
};
