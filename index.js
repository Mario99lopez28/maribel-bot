const TelegramBot = require('node-telegram-bot-api');
const cron = require('node-cron');

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });
const SHEETS_URL = process.env.SHEETS_URL;
const OWNER_ID = process.env.OWNER_CHAT_ID;
const GROQ_API_KEY = process.env.GROQ_API_KEY;

// ── LLAMAR A GOOGLE SHEETS VIA GET ───────────────────
async function sheets(accion, datos = {}) {
  try {
    const params = new URLSearchParams();
    params.append('accion', accion);
    for (const key in datos) {
      if (datos[key] !== undefined && datos[key] !== null) {
        params.append(key, String(datos[key]));
      }
    }
    const url = `${SHEETS_URL}?${params.toString()}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    const text = await res.text();
    try { return JSON.parse(text); }
    catch(e) { return { error: 'Respuesta inválida de Sheets: ' + text.substring(0, 100) }; }
  } catch(e) {
    return { error: 'Error conectando a Sheets: ' + e.message };
  }
}

// ── HERRAMIENTAS ─────────────────────────────────────
const tools = [
  {
    type: "function",
    function: {
      name: "agregar_evento",
      description: "Agrega un evento con fecha y hora a la agenda",
      parameters: {
        type: "object",
        properties: {
          descripcion: { type: "string", description: "Descripción del evento" },
          fechaHora: { type: "string", description: "Fecha y hora ISO 8601, ej: 2026-06-15T10:00:00" }
        },
        required: ["descripcion", "fechaHora"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "agregar_tarea",
      description: "Agrega una tarea sin hora fija",
      parameters: {
        type: "object",
        properties: {
          descripcion: { type: "string", description: "Descripción de la tarea" },
          fecha: { type: "string", description: "Fecha opcional YYYY-MM-DD" }
        },
        required: ["descripcion"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "ver_agenda",
      description: "Muestra los próximos eventos y tareas pendientes",
      parameters: {
        type: "object",
        properties: {
          dias: { type: "number", description: "Cuántos días hacia adelante, default 7" }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "completar_evento",
      description: "Marca un evento o tarea como completado",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "ID del evento, ej: EVT-A1B2C3D4" }
        },
        required: ["id"]
      }
    }
  }
];

// ── EJECUTAR HERRAMIENTA ─────────────────────────────
async function ejecutarTool(nombre, args) {
  try {
    if (nombre === "agregar_evento") {
      if (!args.descripcion || !args.fechaHora) return "Error: faltan datos del evento";
      const r = await sheets("agregar", {
        descripcion: args.descripcion,
        fechaHora: args.fechaHora,
        tipo: "evento"
      });
      return r.ok ? `Evento guardado con ID ${r.id}` : `Error al guardar: ${r.error}`;
    }

    if (nombre === "agregar_tarea") {
      if (!args.descripcion) return "Error: falta la descripción";
      const r = await sheets("agregar", {
        descripcion: args.descripcion,
        fechaHora: args.fecha || "",
        tipo: "tarea"
      });
      return r.ok ? `Tarea guardada con ID ${r.id}` : `Error al guardar: ${r.error}`;
    }

    if (nombre === "ver_agenda") {
      const r = await sheets("listar", { dias: args.dias || 7 });
      if (r.error) return `Error al listar: ${r.error}`;
      if (!r.ok || !r.eventos || r.eventos.length === 0) return "No hay eventos ni tareas pendientes.";
      return r.eventos.map(e => {
        const fecha = e.fechaHora ? new Date(e.fechaHora).toLocaleString('es-AR') : "Sin fecha";
        const icono = e.tipo === "tarea" ? "📌" : "📅";
        return `${icono} [${e.id}] ${e.descripcion} — ${fecha}`;
      }).join('\n');
    }

    if (nombre === "completar_evento") {
      if (!args.id) return "Error: falta el ID";
      const r = await sheets("completar", { id: args.id });
      return r.ok ? "Marcado como completado ✅" : `Error: ${r.error}`;
    }

    return "Herramienta no encontrada";
  } catch(e) {
    return `Error ejecutando herramienta: ${e.message}`;
  }
}

// ── HISTORIAL (máx 4 mensajes para no exceder límite) ─
const historial = [];
const MAX_HISTORIAL = 4;

// ── LLAMAR A GROQ CON REINTENTO ──────────────────────
async function llamarGroq(messages) {
  for (let intento = 0; intento < 3; intento++) {
    try {
      const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${GROQ_API_KEY}`
        },
        body: JSON.stringify({
          model: "llama-3.3-70b-versatile",
          messages,
          tools,
          tool_choice: "auto",
          max_tokens: 800
        }),
        signal: AbortSignal.timeout(30000)
      });

      const data = await res.json();

      if (data.error) {
        // Si el mensaje es muy largo, limpiar historial y reintentar
        if (data.error.message?.includes('reduce the length') && intento < 2) {
          historial.splice(0, historial.length);
          throw new Error('historial_limpiado');
        }
        throw new Error('Groq error: ' + data.error.message);
      }

      if (!data.choices || !data.choices[0]) {
        throw new Error('Respuesta inválida de Groq');
      }

      return data.choices[0].message;
    } catch(e) {
      if (e.message === 'historial_limpiado' && intento < 2) continue;
      if (intento < 2) {
        await new Promise(r => setTimeout(r, 2000));
        continue;
      }
      throw e;
    }
  }
}

// ── PROCESAR MENSAJE ─────────────────────────────────
async function procesarMensaje(texto) {
  const ahora = new Date().toLocaleString('es-AR', { timeZone: 'America/Argentina/Cordoba' });

  historial.push({ role: "user", content: texto });
  while (historial.length > MAX_HISTORIAL) historial.splice(0, 2);

  const messages = [
    {
      role: "system",
      content: `Sos Maribel, una asistente personal simpática que habla en español rioplatense.
Ayudás a gestionar la agenda: eventos con fecha/hora y tareas sin hora fija.
Fecha y hora actual: ${ahora}.
Cuando el usuario quiera agendar algo, usá las herramientas disponibles.
Si el usuario no especifica el año, asumir que es 2026.
Respondé siempre de forma concisa y amigable. Usá emojis con moderación.`
    },
    ...historial
  ];

  let iteraciones = 0;
  while (iteraciones < 5) {
    iteraciones++;
    const msg = await llamarGroq(messages);
    messages.push(msg);

    // Sin tool calls — respuesta final
    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      historial.push({ role: "assistant", content: msg.content });
      while (historial.length > MAX_HISTORIAL) historial.splice(0, 2);
      return msg.content || "Listo!";
    }

    // Ejecutar tool calls
    for (const call of msg.tool_calls) {
      try {
        const args = JSON.parse(call.function.arguments);
        const resultado = await ejecutarTool(call.function.name, args);
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: resultado
        });
      } catch(e) {
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: `Error: ${e.message}`
        });
      }
    }
  }

  return "No pude completar la acción. Intentá de nuevo.";
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
    console.error('Error procesando mensaje:', err.message);
    await bot.sendMessage(msg.chat.id, "❌ Ocurrió un error, intentá de nuevo en unos segundos.");
  }
});

// ── RESUMEN DIARIO A LAS 8AM ─────────────────────────
cron.schedule('0 8 * * *', async () => {
  try {
    const r = await sheets("listar", { dias: 7 });
    if (!r.ok) return;

    if (!r.eventos || r.eventos.length === 0) {
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
    console.error("Error resumen diario:", err.message);
  }
}, { timezone: "America/Argentina/Cordoba" });

// ── RECORDATORIOS CADA MINUTO ────────────────────────
cron.schedule('* * * * *', async () => {
  try {
    const r = await sheets("recordatorios");
    if (!r.ok || !r.pendientes || r.pendientes.length === 0) return;

    for (const evt of r.pendientes) {
      const fecha = new Date(evt.fechaHora).toLocaleString('es-AR');
      await bot.sendMessage(OWNER_ID,
        `⏰ *Recordatorio!*\n\n${evt.descripcion}\n🕐 ${fecha}`,
        { parse_mode: 'Markdown' }
      );
    }
  } catch (err) {
    console.error("Error recordatorios:", err.message);
  }
});

console.log('🤖 Maribel bot iniciado!');
