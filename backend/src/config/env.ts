import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const envSchema = z.object({
  PORT: z.string().default('5000').transform(Number),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  FRONTEND_URL: z.string().default('http://localhost:5173,http://localhost:3000'),
  
  // Firebase Admin Credentials
  FIREBASE_PROJECT_ID: z.string().optional(),
  FIREBASE_CLIENT_EMAIL: z.string().optional(),
  FIREBASE_PRIVATE_KEY: z.string().optional(),
  FIREBASE_SERVICE_ACCOUNT_KEY: z.string().optional(),

  // Cloudinary
  CLOUDINARY_CLOUD_NAME: z.string().optional(),
  CLOUDINARY_API_KEY: z.string().optional(),
  CLOUDINARY_API_SECRET: z.string().optional(),

  // Vercel Blob
  BLOB_READ_WRITE_TOKEN: z.string().optional(),

  // MOM Generator Integration
  MOM_SHEET_ID: z.string().optional(),
  MOM_TEST_SHEET_ID: z.string().optional(),
  MOM_SHEETS_CREDENTIALS_B64: z.string().optional(),
  MOM_ALLOWED_ORIGINS: z.string().optional(),
  MOM_MAX_DELEGATION_HOURS: z.string().optional().transform((val) => (val ? Number(val) : 168)),
  MOM_DEFAULT_DELEGATION_HOURS: z.string().optional().transform((val) => (val ? Number(val) : 24)),
  MOM_NONEXEC_MAX_PAST_DAYS: z.string().optional().transform((val) => (val ? Number(val) : 14)),
  MOM_MAX_FUTURE_DAYS: z.string().optional().transform((val) => (val ? Number(val) : 1)),
});

const parsedEnv = envSchema.safeParse(process.env);

if (!parsedEnv.success) {
  console.error('❌ Invalid environment variables:', parsedEnv.error.format());
  process.exit(1);
}

export const ENV = parsedEnv.data;

export const getAllowedOrigins = (): string[] => {
  return ENV.FRONTEND_URL.split(',').map((url) => url.trim());
};
