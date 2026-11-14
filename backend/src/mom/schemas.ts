import { z } from 'zod';

export const attendanceRecordSchema = z.object({
  roll: z.string().min(1, 'Roll number is required'),
  status: z.enum(['P', 'A'], {
    errorMap: () => ({ message: "Status must be 'P' or 'A'" }),
  }),
});

export const attendancePostSchema = z.object({
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be in YYYY-MM-DD format'),
  type: z.enum(['domain', 'general'], {
    errorMap: () => ({ message: "Type must be 'domain' or 'general'" }),
  }),
  scope: z.string().min(1, 'Scope is required'), // domainKey or 'ALL'
  records: z.array(attendanceRecordSchema).min(1, 'At least one attendance record is required'),
  skipConflicts: z.boolean().optional().default(false),
  dryRun: z.boolean().optional().default(false),
});

export const delegationPostSchema = z.object({
  roll: z.string().min(1, 'Roll number is required'),
  domain: z.string().min(1, 'Domain is required'),
  hours: z.number().positive('Hours must be positive').optional(),
});

