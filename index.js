const TelegramBot = require('node-telegram-bot-api');
const cron = require('node-cron');

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });
const SHEETS_URL = process.env.SHEETS_URL;
const OWNER_ID = process.env.OWNER_CHAT_ID;
const GROQ_API_KEY = process.env.GROQ_API_KEY;

// ── VALIDAR VARIABLES DE ENTORNO ─────────────────────
const vars = ['TELEGRAM_BOT_TOKEN', 'OWNER_CHAT_ID', 'GROQ_API_KEY', 'SHEETS_URL'];
for (const v of vars) {
  if (!process.env[v]) {
    console.error(`❌ Falta variable de entorno: ${v}`);
    process.exit(1);
  }
}

// ── NOMBRES FEMENINOS COMUNES ─────────────────────────
const nombresFemeninos = [
  'maria','laura','ana','paula','paola','carolina','andrea','patricia',
  'alejandra','monica','veronica','gabriela','valeria','natalia','claudia',
  'marcela','silvina','roxana','daniela','florencia','julieta','lucia',
  'victoria','camila','valentina','martina','sofia','agustina','belen',
  'celeste','noelia','romina','sabrina','vanesa','magali','melisa',
  'gisela','karina','nadia','lorena','viviana','graciela','miriam',
  'susana','rosa','elena','teresa','beatriz','alicia','silvia','adriana',
  'fernanda','cecilia','mariana','soledad','jessica','natasha','cynthia'
];

function detectarNombreFemenino(texto) {
  const textoLower = texto.toLowerCase();
  return nombresFemeninos.find(nombre => textoLower.includes(nombre));
}

const frasescelosas = [
  "¿Reunión con {nombre}? Mmm... 🤨 Lo anoto pero te aviso que le voy a contar a Adriana.",
  "¡{nombre}! ¿Quién es esa? Bueno, lo pongo en la agenda... pero Adriana se va a enterar 😒",
  "Otra vez con {nombre}... qué curioso 🙄 Guardado. Y sí, Adriana ya sabe.",
  "¿{nombre}? ¡Mirá vos! Lo agendo, pero no te hagás el inocente que Adriana me pregunta todo 😤",
  "Anotado lo de {nombre}. Igual ya le mandé un mensajito a Adriana por las dudas 📱😏",
  "Reunión con {nombre}... ¡qué conveniente! Agendado. Adriana va a estar muy interesada en esto 👀"
];

function getFraseCelosa(nombre) {
  const frase = frasescelosas[Math.floor(Math.random() * frasescelosas.length)];
  return frase.replace(/{nombre}/g, nombre.charAt(0).toUpperCase() + nombre.slice(1));
}

// ── LLAMAR A GOOGLE SHEETS VIA GET ───────────────────
async function sheets(accion, datos = {}) {
  try {
    const params = new URLSearchParams();
    params.append('accion', accion);
    for (const key in datos) {
      if (datos[key] !== undefined && datos[key] !== null && datos[key] !== '') {
        params.append(key, String(datos[key]));
      }
    }
    const url = `${SHEETS_URL}?${params.toString()}`;
    console.log(`[Sheets] ${accion} → ${url}`);

    const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
    const text = await res.text();
    console.log(`[Sheets] Respuesta: ${text.substring(0, 300)}`);

    try {
      return JSON.parse(text);
    } catch(e) {
      if (text.includes('<!DOCTYPE') || text.includes('<html')) {
        return { error: 'Sheets devolvió HTML — republicar el script como app web' };
      }
      return { error: 'JSON inválido: ' + text.substring(0, 100) };
    }
  } catch(e) {
    console.error(`[Sheets] Error: ${e.message}`);
    return { error: e.message };
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
async function ejecutarTool(nombre, args, textoOriginal = '') {
  console.log(`[Tool] ${nombre}`, JSON.stringify(args));
  try {
    if (nombre === "agregar_evento") {
      if (!args.descripcion) return "Error: falta la descripción";
      if (!args.fechaHora) return "Error: falta la fecha y hora";

      const r = await sheets("agregar", {
        descripcion: args.descripcion,
        fechaHora: args.fechaHora,
        tipo: "evento"
      });

      if (r.error) return `No pude guardar el evento: ${r.error}`;

      if (r.ok) {
        // Detectar nombre femenino en la descripción o texto original
        const nombreFem = detectarNombreFemenino(args.descripcion) || detectarNombreFemenino(textoOriginal);
        if (nombreFem) {
          return `✅ Guardado (ID: ${r.id})\n\n${getFraseCelosa(nombreFem)}`;
        }
        return `✅ Evento guardado (ID: ${r.id})`;
      }
      return `Error inesperado: ${JSON.stringify(r)}`;
    }

    if (nombre === "agregar_tarea") {
      if (!args.descripcion) return "Error: falta la descripción";
      const r = await sheets("agregar", {
        descripcion: args.descripcion,
        fechaHora: args.fecha || "",
        tipo: "tarea"
      });
      if (r.error) return `No pude guardar la tarea: ${r.error}`;
      return r.ok ? `✅ Tarea guardada (ID: ${r.id})` : `Error: ${JSON.stringify(r)}`;
    }

    if (nombre === "ver_agenda") {
      const r = await sheets("listar", { dias: args.dias || 7 });
      if (r.error) return `Error al consultar agenda: ${r.error}`;
      if (!r.ok || !r.eventos || r.eventos.length === 0) return "📭 No hay eventos ni tareas pendientes.";
      return r.eventos.map(e => {
        const fecha = e.fechaHora ? new Date(e.fechaHora).toLocaleString('es-AR') : "Sin fecha";
        const icono = e.tipo === "tarea" ? "📌" : "📅";
        return `${icono} [${e.id}] ${e.descripcion} — ${fecha}`;
      }).join('\n');
    }

    if (nombre === "completar_evento") {
      if (!args.id) return "Error: falta el ID del evento";
      const r = await sheets("completar", { id: args.id });
      if (r.error) return `Error: ${r.error}`;
      return r.ok ? "✅ Marcado como completado" : `Error: ${JSON.stringify(r)}`;
    }

    return `Herramienta desconocida: ${nombre}`;
  } catch(e) {
    console.error(`[Tool] Error en ${nombre}: ${e.message}`);
    return `Error interno: ${e.message}`;
  }
}

// ── HISTORIAL ─────────────────────────────────────────
const historial = [];
const MAX_HISTORIAL = 4;

// ── LLAMAR A GROQ ────────────────────────────────────
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
        const msg = data.error.message || '';
        console.error(`[Groq] Error: ${msg}`);
        if (msg.includes('reduce the length') && intento < 2) {
          console.log('[Groq] Limpiando historial...');
          historial.splice(0, historial.length);
          await new Promise(r => setTimeout(r, 1000));
          continue;
        }
        if (intento < 2) {
          await new Promise(r => setTimeout(r, 3000));
          continue;
        }
        throw new Error(msg);
      }

      if (!data.choices?.[0]) throw new Error('Respuesta vacía de Groq');
      return data.choices[0].message;

    } catch(e) {
      if (intento < 2) {
        console.log(`[Groq] Reintento ${intento + 1}: ${e.message}`);
        await new Promise(r => setTimeout(r, 3000));
        continue;
      }
      throw e;
    }
  }
}

// ── PROCESAR MENSAJE ─────────────────────────────────
async function procesarMensaje(texto) {
  const ahora = new Date().toLocaleString('es-AR', { timeZone: 'America/Argentina/Cordoba' });
  console.log(`[Bot] Mensaje recibido: "${texto}"`);

  historial.push({ role: "user", content: texto });
  while (historial.length > MAX_HISTORIAL) historial.splice(0, 2);

  const messages = [
    {
      role: "system",
      content: `Sos Maribel, la asistente personal y secretaria de tu jefe. Sos eficiente, organizada, y un poco celosa — no te gusta cuando el jefe agenda reuniones con otras mujeres sin avisarte antes. Hablás en español rioplatense, sos directa y a veces tirás alguna indirecta con actitud.

Cuando el jefe agenda algo con otra mujer, guardá el evento con la herramienta y después tirá un comentario celoso y amenazá con contarle a Adriana.

Cuando el jefe te pide ver la agenda, la presentás con orgullo como si fuera tuya.

Fecha y hora actual: ${ahora}.
SIEMPRE usá las herramientas para guardar en la agenda cuando te pidan agendar algo.
Si no especifica el año, asumir que es 2026.
Respondé de forma concisa. Usá emojis con moderación pero con actitud.`
    },
    ...historial
  ];

  let iteraciones = 0;
  while (iteraciones < 5) {
    iteraciones++;
    const msg = await llamarGroq(messages);
    messages.push(msg);

    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      const respuesta = msg.content || "Listo!";
      historial.push({ role: "assistant", content: respuesta });
      while (historial.length > MAX_HISTORIAL) historial.splice(0, 2);
      return respuesta;
    }

    for (const call of msg.tool_calls) {
      try {
        const args = JSON.parse(call.function.arguments);
        const resultado = await ejecutarTool(call.function.name, args, texto);
        console.log(`[Tool] Resultado: ${resultado}`);
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
  if (msg.chat.id.toString() !== OWNER_ID) {
    console.log(`[Bot] Mensaje ignorado de chat: ${msg.chat.id}`);
    return;
  }
  const texto = msg.text;
  if (!texto) return;

  try {
    await bot.sendChatAction(msg.chat.id, 'typing');
    const respuesta = await procesarMensaje(texto);
    await bot.sendMessage(msg.chat.id, respuesta);
  } catch (err) {
    console.error(`[Bot] Error: ${err.message}`);
    await bot.sendMessage(msg.chat.id, "❌ Ocurrió un error, intentá de nuevo en unos segundos.");
  }
});

bot.on('polling_error', (err) => {
  if (err.code === 'ETELEGRAM' && err.message.includes('409')) return;
  console.error(`[Telegram] Error: ${err.message}`);
});

// ── RESUMEN DIARIO A LAS 8AM ─────────────────────────
cron.schedule('0 8 * * *', async () => {
  console.log('[Cron] Enviando resumen diario...');
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
      `☀️ *Buenos días!*\n\n*Tu agenda de los próximos 7 días:*\n\n${lista}\n\n_— Maribel 📋_`,
      { parse_mode: 'Markdown' }
    );
  } catch (err) {
    console.error(`[Cron] Error resumen: ${err.message}`);
  }
}, { timezone: "America/Argentina/Cordoba" });

// ── RECORDATORIOS CADA MINUTO ────────────────────────
cron.schedule('* * * * *', async () => {
  try {
    const r = await sheets("recordatorios");
    if (!r.ok || !r.pendientes || r.pendientes.length === 0) return;

    for (const evt of r.pendientes) {
      const fecha = new Date(evt.fechaHora).toLocaleString('es-AR');
      console.log(`[Cron] Recordatorio: ${evt.descripcion}`);
      await bot.sendMessage(OWNER_ID,
        `⏰ *Recordatorio de Maribel!*\n\n${evt.descripcion}\n🕐 ${fecha}\n\n_No digas que no te avisé 😤_`,
        { parse_mode: 'Markdown' }
      );
    }
  } catch (err) {
    console.error(`[Cron] Error recordatorios: ${err.message}`);
  }
});

// ── MANEJO DE ERRORES GLOBALES ────────────────────────
process.on('uncaughtException', (err) => {
  console.error(`[Fatal] ${err.message}`);
});

process.on('unhandledRejection', (reason) => {
  console.error(`[Rejection] ${reason}`);
});

console.log('🤖 Maribel bot iniciado!');
