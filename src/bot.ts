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

/**
 * OWNER_ID:
 * - Si está en .env y es numérico => ese es el dueño fijo.
 * - Si NO está en .env => el primer usuario que hable se convierte en OWNER.
 */
const ownerEnv = process.env.OWNER_ID;
let OWNER_ID: number | null = null;

if (ownerEnv && ownerEnv.trim() !== "") {
  const parsed = Number(ownerEnv.trim());
  if (!Number.isNaN(parsed)) {
    OWNER_ID = parsed;
  } else {
    console.warn(
      "⚠ OWNER_ID en .env no es un número válido. Se ignorará y se tomará el primer usuario como OWNER."
    );
  }
}

const bot = new TelegramBot(token, { polling: true });

/** Manejo global de errores: que el bot no se caiga **/
process.on("unhandledRejection", (reason) => {
  console.error("⚠ Unhandled Rejection:", reason);
});

process.on("uncaughtException", (err) => {
  console.error("💥 Uncaught Exception:", err);
});

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

/*** Tabla de usuarios y autorización ***/

type UserStatus = "owner" | "approved" | "pending" | "rejected";

interface UserRecord {
  id: number;
  status: UserStatus;
  name: string;
  username?: string;
}

const users = new Map<number, UserRecord>();

// Si el OWNER viene desde .env y es válido, lo registramos
if (OWNER_ID !== null) {
  users.set(OWNER_ID, {
    id: OWNER_ID,
    status: "owner",
    name: "Owner",
  });
}

// helper: saber si ya hay algún owner en la tabla
function hasOwner(): boolean {
  for (const u of users.values()) {
    if (u.status === "owner") return true;
  }
  return false;
}

// Filtro de autorización
async function ensureAuthorized(msg: TelegramBot.Message): Promise<boolean> {
  const from = msg.from;
  if (!from) return false;

  const userId = from.id;
  const chatId = msg.chat.id;
  const name = `${from.first_name || ""} ${from.last_name || ""}`.trim();
  const username = from.username || undefined;

  let record = users.get(userId);

  // Si tenemos OWNER_ID fijo y este usuario está marcado como owner pero NO es el OWNER_ID, lo bajamos a pending
  if (
    OWNER_ID !== null &&
    record &&
    record.status === "owner" &&
    userId !== OWNER_ID
  ) {
    record.status = "pending";
    users.set(userId, record);
  }

  // Si tenemos OWNER_ID en .env:
  if (OWNER_ID !== null) {
    // El dueño real
    if (userId === OWNER_ID) {
      if (!record) {
        record = {
          id: userId,
          status: "owner",
          name: name || "Owner",
          username,
        };
        users.set(userId, record);
      }
      return true;
    }
    // Resto de usuarios pasa por flujo normal (pending / approved / rejected)
  } else {
    // NO hay OWNER_ID en .env: el primer usuario que hable se convierte en OWNER
    if (!hasOwner()) {
      OWNER_ID = userId;
      const ownerRecord: UserRecord = {
        id: userId,
        status: "owner",
        name: name || "Owner",
        username,
      };
      users.set(userId, ownerRecord);

      await bot.sendMessage(
        chatId,
        "🔐 Te has registrado como *OWNER* de este bot.\n" +
          "Solo tú podrás aprobar o rechazar a otros usuarios.",
        { parse_mode: "Markdown" }
      );

      return true;
    }
  }

  // A partir de aquí, el usuario NO es owner
  record = users.get(userId);

  // Usuario nuevo → pending
  if (!record) {
    record = {
      id: userId,
      status: "pending",
      name: name || "(sin nombre)",
      username,
    };
    users.set(userId, record);

    await bot.sendMessage(
      chatId,
      "👋 Hola, tu acceso a este bot está *pendiente de aprobación*.\n" +
        "El dueño revisará tu solicitud y te avisaremos.",
      { parse_mode: "Markdown" }
    );

    if (OWNER_ID !== null) {
      await bot.sendMessage(
        OWNER_ID,
        "🔔 *Nuevo usuario quiere usar el bot:*\n\n" +
          `Nombre: ${record.name}\n` +
          `Usuario: ${record.username ? "@" + record.username : "(sin username)"}\n` +
          `ID: \`${record.id}\``,
        {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [
                { text: "✅ Aprobar", callback_data: `approve:${record.id}` },
                { text: "❌ Rechazar", callback_data: `reject:${record.id}` },
              ],
            ],
          },
        }
      );
    }

    return false;
  }

  // Ya existe en la tabla
  if (record.status === "approved" || record.status === "owner") {
    return true;
  }

  if (record.status === "pending") {
    await bot.sendMessage(
      chatId,
      "⏳ Tu solicitud aún está *pendiente de aprobación*.\n" +
        "Cuando el dueño la revise, te avisaremos.",
      { parse_mode: "Markdown" }
    );
    return false;
  }

  if (record.status === "rejected") {
    await bot.sendMessage(
      chatId,
      "🚫 Tu acceso a este bot ha sido *rechazado*.",
      { parse_mode: "Markdown" }
    );
    return false;
  }

  return false;
}

// Manejo de botones Aprobar / Rechazar
bot.on("callback_query", async (query) => {
  const data = query.data;
  if (!data) return;

  if (OWNER_ID === null) {
    await bot.answerCallbackQuery(query.id, {
      text: "No hay OWNER configurado.",
      show_alert: true,
    });
    return;
  }

  const fromId = query.from.id;
  if (fromId !== OWNER_ID) {
    await bot.answerCallbackQuery(query.id, {
      text: "Solo el OWNER puede gestionar acceso.",
      show_alert: true,
    });
    return;
  }

  const [action, idStr] = data.split(":");
  const targetId = Number(idStr);
  const record = users.get(targetId);

  if (!record) {
    await bot.answerCallbackQuery(query.id, {
      text: "Usuario no encontrado.",
      show_alert: true,
    });
    return;
  }

  if (action === "approve") {
    record.status = "approved";
    users.set(targetId, record);

    await bot.answerCallbackQuery(query.id, { text: "Usuario aprobado ✅" });

    await bot.sendMessage(
      targetId,
      "✅ Tu acceso al bot ha sido *aprobado*.\nYa puedes usar los comandos.",
      { parse_mode: "Markdown" }
    );
    await bot.sendMessage(
      OWNER_ID,
      `✅ Usuario aprobado: ${record.name} (${record.username || record.id})`
    );
  } else if (action === "reject") {
    record.status = "rejected";
    users.set(targetId, record);

    await bot.answerCallbackQuery(query.id, { text: "Usuario rechazado ❌" });

    await bot.sendMessage(
      targetId,
      "🚫 Tu acceso al bot ha sido *rechazado*.",
      { parse_mode: "Markdown" }
    );
    await bot.sendMessage(
      OWNER_ID,
      `❌ Usuario rechazado: ${record.name} (${record.username || record.id})`
    );
  }
});

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

bot.onText(/\/start/, async (msg) => {
  const ok = await ensureAuthorized(msg);
  if (!ok) return;

  const name = msg.from?.first_name || "amigo";
  bot.sendMessage(
    msg.chat.id,
    `Hola ${name} 🧪\nSoy tu bot de búsqueda de empleos.\n\n` +
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

bot.onText(/\/filtros/, async (msg) => {
  const ok = await ensureAuthorized(msg);
  if (!ok) return;

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

/** /perfil con o sin texto **/
bot.onText(/\/perfil(?:\s+(.+))?/, async (msg, match) => {
  const ok = await ensureAuthorized(msg);
  if (!ok) return;

  const f = getFilter(msg.chat.id);
  const text = (match?.[1] ?? "").trim();

  if (!text) {
    bot.sendMessage(
      msg.chat.id,
      "Para actualizar el perfil, usa por ejemplo:\n\n" +
        "/perfil quimico farmaceutico, aseguramiento de calidad"
    );
    return;
  }

  f.keywords = text
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);

  bot.sendMessage(msg.chat.id, `✅ Perfil actualizado: ${f.keywords.join(", ")}`);
});

/** /ubicacion con o sin texto **/
bot.onText(/\/ubicacion(?:\s+(.+))?/, async (msg, match) => {
  const ok = await ensureAuthorized(msg);
  if (!ok) return;

  const f = getFilter(msg.chat.id);
  const text = (match?.[1] ?? "").trim();

  if (!text) {
    bot.sendMessage(
      msg.chat.id,
      "Para actualizar la ubicación, usa por ejemplo:\n\n" +
        "/ubicacion Bogota, Colombia"
    );
    return;
  }

  f.location = text;
  bot.sendMessage(msg.chat.id, `✅ Ubicación actualizada: ${f.location}`);
});

/** /salario con validación **/
bot.onText(/\/salario(?:\s+(.+))?/, async (msg, match) => {
  const ok = await ensureAuthorized(msg);
  if (!ok) return;

  const f = getFilter(msg.chat.id);
  const text = (match?.[1] ?? "").trim();

  if (!text) {
    bot.sendMessage(
      msg.chat.id,
      "Para actualizar el salario, usa por ejemplo:\n\n" +
        "/salario 4000000-8000000"
    );
    return;
  }

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

  let all: Job[] = [];

  try {
    all = await scrapeJobs(keyword, location);
  } catch (err) {
    console.error("Error en scrapeJobs:", err);
    await bot.sendMessage(
      chatId,
      "⚠ Hubo un error al conectarme con los portales de empleo.\n" +
        "Intenta de nuevo más tarde o ajusta los filtros."
    );
    return;
  }

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
    try {
      await bot.sendMessage(chatId, jobToMessage(job), { parse_mode: "Markdown" });
    } catch (err) {
      console.error("Error enviando mensaje de oferta:", err);
    }
  }
}

/*** Comandos de búsqueda ***/

bot.onText(/\/hoy/, async (msg) => {
  const ok = await ensureAuthorized(msg);
  if (!ok) return;
  await buscarYEnviar(msg.chat.id, 1, false);
});

bot.onText(/\/semana/, async (msg) => {
  const ok = await ensureAuthorized(msg);
  if (!ok) return;
  await buscarYEnviar(msg.chat.id, 7, false);
});

bot.onText(/\/urgentes/, async (msg) => {
  const ok = await ensureAuthorized(msg);
  if (!ok) return;
  await buscarYEnviar(msg.chat.id, null, true);
});

console.log("🤖 JobBot iniciado. Esperando mensajes...");
