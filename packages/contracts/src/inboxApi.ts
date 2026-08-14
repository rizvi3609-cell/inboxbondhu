import { z } from 'zod'
import { objectIdString } from './common.js'

/** Inbox API bodies/queries (§7.3 #40–45). */

export const ListConversationsQuerySchema = z
  .object({
    status: z.enum(['open', 'pending', 'resolved']).optional(),
    mode: z.enum(['ai', 'human']).optional(),
    assignedTo: objectIdString.optional(),
    channelId: objectIdString.optional(),
    q: z.string().max(140).optional(),
    updatedSince: z.coerce.date().optional(), // socket-reconnect reconciliation
    cursor: z.string().datetime().optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(), // default 20 in the service
  })
  .strict()
export type ListConversationsQuerySchema = z.infer<typeof ListConversationsQuerySchema>

export const UpdateConversationBody = z
  .object({
    status: z.enum(['open', 'pending', 'resolved']).optional(),
    mode: z.enum(['ai', 'human']).optional(),
    assignedTo: objectIdString.nullable().optional(),
    tags: z.array(z.string().min(1).max(40)).max(20).optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'at least one field required')
export type UpdateConversationBody = z.infer<typeof UpdateConversationBody>

export const SendMessageBody = z
  .object({
    text: z.string().trim().min(1).max(4000),
  })
  .strict()
export type SendMessageBody = z.infer<typeof SendMessageBody>

export const ListMessagesQuerySchema = z
  .object({
    cursor: z.string().datetime().optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(), // default 25 (normal lists)
  })
  .strict()
