export type AppState = 'calibrating' | 'waiting' | 'recording' | 'thinking' | 'idle';
export type Screen   = 'chat' | 'db';
export type Role     = 'user' | 'assistant';

export interface Message {
  role: Role;
  content: string;
}

export interface AnimalRecord {
  id: string;
  timestamp: string;
  animal_type: string;
  individual_name: string;
  data: Record<string, unknown>;
  raw_conversation: Message[];
}
