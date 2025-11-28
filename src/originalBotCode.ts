// src/bot.ts
import TelegramBot from "node-telegram-bot-api";
import dotenv from "dotenv";
import { scrapeJobs } from "./scraper";
import { Job } from "./types/Job";

dotenv.config();

const token = process.env.TELEGRAM_TOKEN;
if (!token) {
  throw new Error("Falta TELEGRAM_TOKEN en .env");
}

const bot = new TelegramBot(token, { polling: true });

/*** Helpers ***/
function normalize(text: string): string {
  return (text || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .toLowerCase()
    .trim();
}

function isRecent(job: Job, days: number): boolean {
  if (!job.postedAt) return true; // si no hay fecha, no filtramos por fecha
  const now = new Date();
  const diffDays =
    (now.getTime() - job.postedAt.getTime()) / (1000 * 60 * 60 * 24);
  return diffDays <= days;
}

function isUrgent(job: Job): boolean {
  if (job.urgent) return true;
  const txt = normalize(`${job.title} ${job.description ?? ""}`);
  return (
    txt.includes("urgente") ||
    txt.includes("urgent") ||
    txt.includes("contratacion inmediata") ||
    txt.includes("contratacion urgente") ||
    txt.includes("inmediata") ||
    txt.includes("se busca urgente") ||
    txt.includes("urgentemente")
  );
}

/*** Estado de filtros por chat ***/

interface FilterState {
  keywords: string[];   // perfil
  location: string;     // una ubicación principal
  minSalary?: number;
  maxSalary?: number;
}

const defaultFilter: FilterState = {
  keywords: ["quimico farmaceutico"],
  location: "Bogota, Colombia",
};

const filtersByChat = new Map<number, FilterState>();

function getFilter(chatId: number): FilterState {
  if (!filtersByChat.has(chatId)) {
    filtersByChat.set(chatId, { ...defaultFilter });
  }
  return filtersByChat.get(chatId)!;
}

/*** Formato de mensaje de oferta ***/

function jobToMessage(job: Job): string {
  const salaryText = job.isSalaryConfidential
    ? "💰 Salario confidencial"
    : job.salaryMin || job.salaryMax
    ? `💰 ${job.salaryMin?.toLocaleString("es-CO")} - ${job.salaryMax?.toLocaleString("es-CO")}`
    : "💰 Salario no especificado";

  const urgentText = isUrgent(job) ? "🚨 *URGENTE*\n" : "";

  return (
    `${urgentText}` +
    `🏢 *${job.company}*\n` +
    `📌 *${job.title}*\n` +
    `📍 ${job.location}\n` +
    `${salaryText}\n` +
    `🔗 [Ver oferta](${job.link})\n` +
    `📎 Fuente: ${job.source}`
  );
}

/*** Comandos ***/

bot.onText(/\/start/, (msg) => {
  const name = msg.from?.first_name || "amigo";
  bot.sendMessage(
    msg.chat.id,
    `Hola ${name} 🧪\nSoy tu bot de empleos para Maura.\n\n` +
      "Comandos:\n" +
      "/filtros – Ver filtros actuales\n" +
      "/perfil <texto> – Cambiar perfil (ej: quimico farmaceutico)\n" +
      "/ubicacion <texto> – Cambiar ubicación (ej: Bogota, Colombia)\n" +
      "/salario <min>-<max> – Rango en COP\n\n" +
      "/hoy – Ofertas de las últimas 24 horas\n" +
      "/semana – Ofertas de la última semana\n" +
      "/urgentes – Ofertas marcadas urgentes",
    { parse_mode: "Markdown" }
  );
});

bot.onText(/\/filtros/, (msg) => {
  const f = getFilter(msg.chat.id);
  bot.sendMessage(
    msg.chat.id,
    "*Filtros actuales:*\n\n" +
      `• Perfil: ${f.keywords.join(", ")}\n` +
      `• Ubicación: ${f.location}\n` +
      `• Salario: ${f.minSalary || "(min)"} - ${f.maxSalary || "(max)"}\n`,
    { parse_mode: "Markdown" }
  );
});

bot.onText(/\/perfil (.+)/, (msg, match) => {
  const f = getFilter(msg.chat.id);
  const text = match?.[1] ?? "";
  f.keywords = text
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);

  bot.sendMessage(msg.chat.id, `✅ Perfil actualizado: ${f.keywords.join(", ")}`);
});

bot.onText(/\/ubicacion (.+)/, (msg, match) => {
  const f = getFilter(msg.chat.id);
  const text = match?.[1] ?? "";
  f.location = text.trim();
  bot.sendMessage(msg.chat.id, `✅ Ubicación actualizada: ${f.location}`);
});

bot.onText(/\/salario (.+)/, (msg, match) => {
  const f = getFilter(msg.chat.id);
  const text = match?.[1] ?? "";
  const parts = text.split("-").map((p) => p.trim());

  const min = parts[0] ? Number(parts[0]) : undefined;
  const max = parts[1] ? Number(parts[1]) : undefined;

  if ((min && isNaN(min)) || (max && isNaN(max))) {
    bot.sendMessage(msg.chat.id, "Formato inválido. Usa: /salario 4000000-8000000");
    return;
  }

  f.minSalary = min;
  f.maxSalary = max;

  bot.sendMessage(
    msg.chat.id,
    `✅ Salario actualizado:\nMín: ${min || "(sin mínimo)"}\nMáx: ${max || "(sin máximo)"}`
  );
});

/*** Lógica común de búsqueda y filtrado en memoria ***/

async function buscarYEnviar(
  chatId: number,
  days: number | null,   // 1 = hoy, 7 = semana, null = sin filtro fecha
  soloUrgentes: boolean
) {
  const f = getFilter(chatId);

  const keyword =
    f.keywords.length > 0 ? f.keywords.join(" ") : "quimico farmaceutico";
  const location = f.location || "Bogota, Colombia";

  await bot.sendMessage(
    chatId,
    `🔍 Buscando ofertas para:\nPerfil: ${keyword}\nUbicación: ${location}...`
  );

  const all = await scrapeJobs(keyword, location);

  let jobs = all;

  if (f.minSalary) {
    jobs = jobs.filter(
      (j) =>
        (j.salaryMin && j.salaryMin >= f.minSalary!) ||
        (j.salaryMax && j.salaryMax >= f.minSalary!)
    );
  }

  if (f.maxSalary) {
    jobs = jobs.filter(
      (j) =>
        (j.salaryMax && j.salaryMax <= f.maxSalary!) ||
        (j.salaryMin && j.salaryMin <= f.maxSalary!)
    );
  }

  if (days !== null) {
    jobs = jobs.filter((j) => isRecent(j, days));
  }

  if (soloUrgentes) {
    jobs = jobs.filter((j) => isUrgent(j));
  }

  if (jobs.length === 0) {
    await bot.sendMessage(
      chatId,
      "No encontré ofertas con esos filtros. Prueba cambiando perfil, ubicación o salario."
    );
    return;
  }

  for (const job of jobs.slice(0, 10)) {
    await bot.sendMessage(chatId, jobToMessage(job), { parse_mode: "Markdown" });
  }
}

/*** Comandos de búsqueda ***/

bot.onText(/\/hoy/, async (msg) => {
  await buscarYEnviar(msg.chat.id, 1, false);
});

bot.onText(/\/semana/, async (msg) => {
  await buscarYEnviar(msg.chat.id, 7, false);
});

bot.onText(/\/urgentes/, async (msg) => {
  await buscarYEnviar(msg.chat.id, null, true);
});

console.log("🤖 JobBot iniciado. Esperando mensajes...");
