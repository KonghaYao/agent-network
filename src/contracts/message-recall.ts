import { z } from 'zod';

const id = z.string().min(1).max(128);
export const messageRecallSchema = z.object({ request_id: z.string().min(1).max(128), message_id: id }).strict();
export type MessageRecallInput = z.infer<typeof messageRecallSchema>;
