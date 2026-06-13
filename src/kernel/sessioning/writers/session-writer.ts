import type { Message } from "@/sys";
export interface SessionWriter {
  write(message: Message): void;
}
