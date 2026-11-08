import { z } from "zod";

const reservedSlugs = new Set(["admin", "api", "auth", "help", "login", "public", "signup", "support", "www"]);

export const createTenantSchema = z.object({
  name: z.string().trim().min(2).max(120),
  slug: z.string().trim().toLowerCase().min(2).max(80).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  timezone: z.string().trim().min(1).max(80).default("UTC"),
  locale: z.string().trim().min(2).max(35).default("en-US"),
}).strict().superRefine((value, ctx) => {
  if (reservedSlugs.has(value.slug)) ctx.addIssue({ code: "custom", path: ["slug"], message: "This organization URL is reserved" });
  try { new Intl.DateTimeFormat("en-US", { timeZone: value.timezone }); }
  catch { ctx.addIssue({ code: "custom", path: ["timezone"], message: "Timezone must be a valid IANA timezone" }); }
  try { Intl.getCanonicalLocales(value.locale); }
  catch { ctx.addIssue({ code: "custom", path: ["locale"], message: "Locale must be a valid BCP 47 locale" }); }
});

export type CreateTenantInput = z.infer<typeof createTenantSchema>;
