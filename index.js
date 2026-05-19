require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const Anthropic = require('@anthropic-ai/sdk');
const cron = require('node-cron');
const axios = require('axios');

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });
const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const SHEETS_URL = process.env.SHEETS_URL;
const OWNER_ID = process.env.OWNER_CHAT_ID;

// ── HISTORIAL DE CONVERSACIÓN ────────────────────────
const historial = [];

// ── LLAMAR A GOOGLE SHEETS ───────────────────────────
async function sheets(accion, datos = {}) {
  const res = await axios.post(SHEETS_URL, { accion, ...datos });
  return res.data;
}

// ── HERRAMIENTAS QUE USA CLAUDE ──────────────────────
const tools = [
  {
    name: "agregar_evento",
    description: "Agrega un evento con fecha y hora a la agenda",
    input_schema: {
      type: "object",
      properties: {
        descripcion: { type: "string", description: "Descripción del evento" },
        fechaHora:   { type: "string", description: "Fecha y hora ISO 8601, ej: 2026-06-15T10:00:00" }
      },
      required: ["descripcion", "fechaHora"]
    }
  },
  {
    name: "agregar_tarea",
    description: "Agrega una tarea sin hora fija",
    input_schema: {
      type: "object",
      properties: {
        descripcion: { type: "string", description: "Descripción de la tarea" },
        fecha: { type: "string", description: "Fecha opcional en formato YYYY-MM-DD" }
      },
      required: ["descripcion"]
    }
  },
  {
    name: "ver_agenda",
    description: "Muestra los próximos eventos y tareas pendientes",
    input_schema: {
      type: "object",
      properties: {
        dias: { type: "number", description: "Cuántos días hacia adelante mostrar, default 7" }
      }
    }
  },
  {
    name: "completar_evento",
    description: "Marca un evento o tarea como completado",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string", description: "ID del evento, ej: EVT-A1B2C3D4" }
      },
      required: ["id"]
    }
  }
];

// ── EJECUTAR HERRAMIENTA ─────────────────────────────
async function ejecutarTool(nombre, input) {
  if (nombre === "agregar_evento") {
    const r = await sheets("agregar", {
      descripcion: input.descripcion,
      fechaHora: input.fechaHora,
      tipo: "evento"
    });
    return r.ok ? `✅ Evento guardado (${r.id})` : `❌ Error: ${r.error}`;
  }

  if (nombre === "agregar_tarea") {
    const r = await sheets("agregar", {
      descripcion: input.descripcion,
      fechaHora: input.fecha || "",
      tipo: "tarea"
    });
    return r.ok ? `✅ Tarea guardada (${r.id})` : `❌ Error: ${r.error}`;
  }

  if (nombre === "ver_agenda") {
    const r = await sheets("listar", { dias: input.dias || 7 });
    if (!r.ok || r.eventos.length === 0) return "📭 No hay eventos ni tareas pendientes.";
    return r.eventos.map(e => {
      const fecha = e.fechaHora ? new Date(e.fechaHora).toLocaleString('es-AR') : "Sin fecha";
      const icono = e.tipo === "tarea" ? "📌" : "📅";
      return `${icono} [${e.id}] ${e.descripcion} — ${fecha}`;
    }).join('\n');
  }

  if (nombre === "completar_evento") {
    const r = await sheets("completar", { id: input.id });
    return r.ok ? `✅ Marcado como completado` : `❌ ${r.error}`;
  }
}

// ── PROCESAR MENSAJE CON CLAUDE ──────────────────────
async function procesarMensaje(texto) {
  historial.push({ role: "user", content: texto });
  if (historial.length > 20) historial.splice(0, 2);

  let mensajes = [...historial];

  while (true) {
    const response = await claude.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1000,
      system: `Sos Maribel, una asistente personal simpática que habla en español rioplatense.
Ayudás a gestionar la agenda: eventos con fecha/hora y tareas sin hora fija.
Fecha y hora actual: ${new Date().toLocaleString('es-AR', { timeZone: 'America/Argentina/Cordoba' })}.
Cuando el usuario quiera agendar algo, usá las herramientas.
Respondé siempre de forma concisa y amigable. Usá emojis con moderación.`,
      tools,
      messages: mensajes
    });

    if (response.stop_reason === "end_turn") {
      const texto = response.content.find(b => b.type === "text")?.text || "Listo!";
      historial.push({ role: "assistant", content: response.content });
      return texto;
    }

    if (response.stop_reason === "tool_use") {
      historial.push({ role: "assistant", content: response.content });
      mensajes = [...historial];

      const resultados = [];
      for (const bloque of response.content) {
        if (bloque.type === "tool_use") {
          const resultado = await ejecutarTool(bloque.name, bloque.input);
          resultados.push({
            type: "tool_result",
            tool_use_id: bloque.id,
            content: resultado
          });
        }
      }

      historial.push({ role: "user", content: resultados });
      mensajes = [...historial];
    }
  }
}

// ── ESCUCHAR MENSAJES TELEGRAM ───────────────────────
bot.on('message', async (msg) => {
  if (msg.chat.id.toString() !== OWNER_ID) return;
  const texto = msg.text;
  if (!texto) return;

  try {
    await bot.sendChatAction(msg.chat.id, 'typing');
    const respuesta = await procesarMensaje(texto);
    await bot.sendMessage(msg.chat.id, respuesta);
  } catch (err) {
    console.error(err);
    await bot.sendMessage(msg.chat.id, "❌ Ocurrió un error, intentá de nuevo.");
  }
});

// ── RESUMEN DIARIO ───────────────────────────────────
cron.schedule('0 8 * * *', async () => {
  try {
    const r = await sheets("listar", { dias: 7 });
    if (!r.ok) return;

    if (r.eventos.length === 0) {
      await bot.sendMessage(OWNER_ID, "☀️ *Buenos días!*\n\nNo tenés nada agendado para los próximos 7 días. Día libre! 🎉", { parse_mode: 'Markdown' });
      return;
    }

    const lista = r.eventos.map(e => {
      const fecha = e.fechaHora ? new Date(e.fechaHora).toLocaleString('es-AR') : "Sin fecha";
      const icono = e.tipo === "tarea" ? "📌" : "📅";
      return `${icono} ${e.descripcion} — ${fecha}`;
    }).join('\n');

    await bot.sendMessage(OWNER_ID,
      `☀️ *Buenos días Maribel!*\n\n*Tu agenda de los próximos 7 días:*\n\n${lista}`,
      { parse_mode: 'Markdown' }
    );
  } catch (err) {
    console.error("Error resumen diario:", err);
  }
}, { timezone: "America/Argentina/Cordoba" });

// ── RECORDATORIOS CADA MINUTO ────────────────────────
cron.schedule('* * * * *', async () => {
  try {
    const r = await sheets("recordatorios");
    if (!r.ok || r.pendientes.length === 0) return;

    for (const evt of r.pendientes) {
      const fecha = new Date(evt.fechaHora).toLocaleString('es-AR');
      await bot.sendMessage(OWNER_ID,
        `⏰ *Recordatorio!*\n\n${evt.descripcion}\n🕐 ${fecha}`,
        { parse_mode: 'Markdown' }
      );
    }
  } catch (err) {
    console.error("Error recordatorios:", err);
  }
});

console.log('🤖 Maribel bot iniciado!');
