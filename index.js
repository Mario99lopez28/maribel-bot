const TelegramBot = require('node-telegram-bot-api');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const cron = require('node-cron');
const axios = require('axios');

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const SHEETS_URL = process.env.SHEETS_URL;
const OWNER_ID = process.env.OWNER_CHAT_ID;

// ── LLAMAR A GOOGLE SHEETS ───────────────────────────
async function sheets(accion, datos = {}) {
  const res = await axios.post(SHEETS_URL, { accion, ...datos }, {
    maxRedirects: 5,
    timeout: 15000
  });
  return res.data;
}

// ── HERRAMIENTAS QUE USA GEMINI ──────────────────────
const tools = [{
  functionDeclarations: [
    {
      name: "agregar_evento",
      description: "Agrega un evento con fecha y hora a la agenda",
      parameters: {
        type: "OBJECT",
        properties: {
          descripcion: { type: "STRING", description: "Descripción del evento" },
          fechaHora:   { type: "STRING", description: "Fecha y hora ISO 8601, ej: 2026-06-15T10:00:00" }
        },
        required: ["descripcion", "fechaHora"]
      }
    },
    {
      name: "agregar_tarea",
      description: "Agrega una tarea sin hora fija",
      parameters: {
        type: "OBJECT",
        properties: {
          descripcion: { type: "STRING", description: "Descripción de la tarea" },
          fecha: { type: "STRING", description: "Fecha opcional YYYY-MM-DD" }
        },
        required: ["descripcion"]
      }
    },
    {
      name: "ver_agenda",
      description: "Muestra los próximos eventos y tareas pendientes",
      parameters: {
        type: "OBJECT",
        properties: {
          dias: { type: "NUMBER", description: "Cuántos días hacia adelante, default 7" }
        }
      }
    },
    {
      name: "completar_evento",
      description: "Marca un evento o tarea como completado",
      parameters: {
        type: "OBJECT",
        properties: {
          id: { type: "STRING", description: "ID del evento, ej: EVT-A1B2C3D4" }
        },
        required: ["id"]
      }
    }
  ]
}];

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

// ── PROCESAR MENSAJE CON GEMINI ──────────────────────
const historialChat = [];

async function procesarMensaje(texto) {
  const ahora = new Date().toLocaleString('es-AR', { timeZone: 'America/Argentina/Cordoba' });

  const model = genAI.getGenerativeModel({
    model: "gemini-2.0-flash",
    systemInstruction: `Sos Maribel, una asistente personal simpática que habla en español rioplatense.
Ayudás a gestionar la agenda: eventos con fecha/hora y tareas sin hora fija.
Fecha y hora actual: ${ahora}.
Cuando el usuario quiera agendar algo, usá las herramientas.
Respondé siempre de forma concisa y amigable. Usá emojis con moderación.`,
    tools
  });

  const chat = model.startChat({ history: historialChat });
  let result = await chat.sendMessage(texto);
  let response = result.response;

  // Loop para manejar tool calls
  while (response.functionCalls && response.functionCalls().length > 0) {
    const calls = response.functionCalls();
    const resultados = [];

    for (const call of calls) {
      const resultado = await ejecutarTool(call.name, call.args);
      resultados.push({
        functionResponse: {
          name: call.name,
          response: { result: resultado }
        }
      });
    }

    result = await chat.sendMessage(resultados);
    response = result.response;
  }

  // Guardar en historial
  historialChat.push({ role: "user", parts: [{ text: texto }] });
  historialChat.push({ role: "model", parts: [{ text: response.text() }] });
  if (historialChat.length > 20) historialChat.splice(0, 2);

  return response.text();
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
