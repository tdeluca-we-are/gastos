// =====================================================================
// Bot de WhatsApp para Mis Gastos (Supabase Edge Function "wpp-gastos")
//
// Le escribís o le mandás un audio al número del bot ("gasté 12 lucas en el
// súper") y lo carga en tu documento de gas_estado, el mismo que usa la app.
// Gemini (nivel gratuito) interpreta el texto o el audio.
//
// Secrets (Edge Functions → Secrets):
//   WPP_TOKEN       token de acceso de la API de WhatsApp (Meta)
//   WPP_PHONE_ID    "Phone number ID" del número del bot
//   WPP_VERIFY      texto cualquiera; el mismo que ponés en "Verify token" del webhook
//   WPP_PERMITIDOS  tu número con código de país, ej 5491122334455 (varios separados por coma)
//   GEMINI_KEY      API key de Google AI Studio
//   WPP_APP_SECRET  (opcional, recomendado) "App secret" de la app de Meta: valida que el aviso venga de Meta
//   GASTOS_USER_ID  (opcional) tu user_id; si no está y hay una sola fila en gas_estado, usa esa
//
// Importante: desplegar con "Verify JWT" APAGADO — Meta no manda el token de Supabase.
// =====================================================================

import { createClient } from 'npm:@supabase/supabase-js@2';

const env = (k: string) => Deno.env.get(k) ?? '';
const WPP_TOKEN = env('WPP_TOKEN');
const WPP_PHONE_ID = env('WPP_PHONE_ID');
const WPP_VERIFY = env('WPP_VERIFY');
const WPP_APP_SECRET = env('WPP_APP_SECRET');
const GEMINI_KEY = env('GEMINI_KEY');
const MODELO = env('GEMINI_MODEL') || 'gemini-2.5-flash';
const GRAPH = 'https://graph.facebook.com/v21.0';
const TABLA = 'gas_estado';

// Argentina: WhatsApp avisa desde 549XXXXXXXXXX pero para responder Meta pide 54XXXXXXXXXX (sin el 9)
const normAR = (n: string) => String(n || '').replace(/\D/g, '').replace(/^549/, '54');
const PERMITIDOS = env('WPP_PERMITIDOS').split(',').map(normAR).filter(Boolean);

const sb = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } });

// ---------- utilidades ----------
const NF = new Intl.NumberFormat('es-AR', { maximumFractionDigits: 0 });
const plata = (n: number) => (n < 0 ? '-' : '') + '$' + NF.format(Math.abs(Math.round(n || 0)));
const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const DOW = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
function hoyAR() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' }).format(new Date());
}
function dowDe(iso: string) {
  const [y, m, d] = iso.split('-').map(Number);
  return DOW[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
function b64(u: Uint8Array) {
  let s = '';
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s);
}

// ---------- mismos cálculos que la app ----------
// deno-lint-ignore no-explicit-any
type Doc = any;
function montoFijo(f: Doc, m: string) {
  const ks = Object.keys(f.montos || {}).sort();
  if (!ks.length) return f.monto || 0;
  let v = f.montos[ks[0]];
  for (const k of ks) if (k <= m) v = f.montos[k];
  return v;
}
function totales(d: Doc, m: string) {
  let g = 0, i = 0;
  const cat: Record<string, number> = {};
  for (const x of d.movs || []) {
    if (String(x.fecha).slice(0, 7) !== m) continue;
    if (x.t === 'g') { g += x.monto; cat[x.cat] = (cat[x.cat] || 0) + x.monto; } else i += x.monto;
  }
  for (const f of d.fijos || []) {
    if (!(f.desde <= m && (!f.hasta || m <= f.hasta))) continue;
    const v = montoFijo(f, m);
    if (f.t === 'g') { g += v; cat[f.cat] = (cat[f.cat] || 0) + v; } else i += v;
  }
  return { g, i, cat };
}
function catDe(d: Doc, t: string, id: string) {
  const L = (t === 'i' ? d.catsI : d.cats) || [];
  return L.find((c: Doc) => c.id === id) || { id: 'otros', e: t === 'i' ? '💰' : '📦', n: 'Otros' };
}

// ---------- WhatsApp ----------
async function responder(to: string, texto: string) {
  const r = await fetch(`${GRAPH}/${WPP_PHONE_ID}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${WPP_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body: texto } }),
  });
  if (!r.ok) console.error('error respondiendo', r.status, await r.text());
}
function marcarLeido(id: string) {
  return fetch(`${GRAPH}/${WPP_PHONE_ID}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${WPP_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', status: 'read', message_id: id }),
  }).catch(() => {});
}
async function bajarMedia(id: string) {
  const r = await fetch(`${GRAPH}/${id}`, { headers: { Authorization: `Bearer ${WPP_TOKEN}` } });
  if (!r.ok) throw new Error('no pude bajar el audio (' + r.status + ')');
  const j = await r.json();
  const a = await fetch(j.url, { headers: { Authorization: `Bearer ${WPP_TOKEN}` } });
  if (!a.ok) throw new Error('no pude bajar el audio (' + a.status + ')');
  return b64(new Uint8Array(await a.arrayBuffer()));
}
async function firmaOk(req: Request, body: string) {
  if (!WPP_APP_SECRET) return true;
  const sig = req.headers.get('x-hub-signature-256') || '';
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(WPP_APP_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)));
  return sig === 'sha256=' + Array.from(mac).map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ---------- datos ----------
async function miUsuario(): Promise<string | null> {
  const fijo = env('GASTOS_USER_ID');
  if (fijo) return fijo;
  const { data, error } = await sb.from(TABLA).select('user_id').limit(2);
  if (error) throw error;
  return data && data.length === 1 ? data[0].user_id : null;
}
// Lee, aplica el cambio y guarda con el mismo control de versión que la app
async function modificar(uidUser: string, fn: (d: Doc) => void) {
  for (let intento = 0; intento < 4; intento++) {
    const { data, error } = await sb.from(TABLA).select('datos,version').eq('user_id', uidUser).single();
    if (error) throw error;
    const d = data.datos || {};
    d.movs = d.movs || [];
    fn(d);
    const { data: up, error: e2 } = await sb.from(TABLA)
      .update({ datos: d, version: data.version + 1, actualizado: new Date().toISOString() })
      .eq('user_id', uidUser).eq('version', data.version).select('version');
    if (e2) throw e2;
    if (up && up.length) return d;
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error('no pude guardar (la app estaba guardando al mismo tiempo), probá de nuevo');
}

// ---------- Gemini ----------
// deno-lint-ignore no-explicit-any
async function interpretar(parte: any, d: Doc, esAudio: boolean) {
  const hoy = hoyAR();
  const lista = (L: Doc[]) => (L || []).map((c) => `- ${c.id}: ${c.e} ${c.n}`).join('\n');
  const prompt = `Sos el asistente de una app personal de control de gastos (Argentina, montos en pesos).
El dueño te manda un mensaje ${esAudio ? 'de AUDIO (adjunto)' : 'de texto'}. Hoy es ${dowDe(hoy)} ${hoy}.

Categorías de GASTO (id: nombre):
${lista(d.cats)}

Categorías de INGRESO (id: nombre):
${lista(d.catsI)}

Decidí la acción:
- "cargar": el mensaje registra uno o más gastos o ingresos (ej: "gasté 12 lucas en el súper", "cobré 200 mil de un freelance", "nafta 30k y un café 3500").
- "borrar_ultimo": pide borrar, deshacer o corregir lo último que cargó.
- "resumen": pregunta cuánto gastó, cómo viene el mes, cuánto le queda.
- "nada": cualquier otra cosa.

Para cada movimiento:
- tipo: "g" gasto o "i" ingreso.
- monto: número en pesos sin separadores. "luca"/"lucas"/"k"/"mil" = ×1000 ("5 lucas" = 5000, "luca y media" = 1500); "palo"/"millón" = ×1000000; "12.500" = 12500.
- cat: el id EXACTO de la lista que mejor encaje (súper/chino/almacén → súper; delivery/restaurant/café → comida; nafta/uber/sube/peaje → transporte). Si ninguno encaja, "otros".
- desc: detalle corto con mayúscula inicial y sin el monto (ej "Coto", "Nafta", "Cena con amigos").
- fecha: YYYY-MM-DD. Hoy, salvo que diga "ayer", "el sábado", "el 3", etc.

Si es audio, en "transcripcion" poné lo que dijo.
Si la acción es "nada", en "respuesta" poné una respuesta breve y amable en español rioplatense que explique que puede mandarte gastos por texto o audio.`;

  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODELO}:generateContent?key=${GEMINI_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }, parte] }],
      generationConfig: {
        temperature: 0,
        responseMimeType: 'application/json',
        responseSchema: {
          type: 'OBJECT',
          properties: {
            accion: { type: 'STRING', enum: ['cargar', 'borrar_ultimo', 'resumen', 'nada'] },
            movimientos: {
              type: 'ARRAY',
              items: {
                type: 'OBJECT',
                properties: {
                  tipo: { type: 'STRING', enum: ['g', 'i'] },
                  monto: { type: 'NUMBER' },
                  cat: { type: 'STRING' },
                  desc: { type: 'STRING' },
                  fecha: { type: 'STRING' },
                },
                required: ['tipo', 'monto', 'cat', 'desc', 'fecha'],
              },
            },
            transcripcion: { type: 'STRING' },
            respuesta: { type: 'STRING' },
          },
          required: ['accion'],
        },
      },
    }),
  });
  if (r.status === 429) throw new Error('la IA gratuita está saturada, probá en un minuto 🙏');
  if (!r.ok) throw new Error('Gemini respondió ' + r.status + ': ' + (await r.text()).slice(0, 200));
  const j = await r.json();
  const txt = j?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!txt) throw new Error('Gemini no devolvió nada');
  return JSON.parse(txt);
}

// ---------- el mensaje ----------
// deno-lint-ignore no-explicit-any
async function procesarMensaje(m: any) {
  const para = normAR(m.from);
  if (!PERMITIDOS.includes(para)) { console.log('número no permitido', m.from); return; }
  marcarLeido(m.id);
  try {
    let parte;
    if (m.type === 'text') parte = { text: 'Mensaje: ' + m.text.body };
    else if (m.type === 'audio') {
      parte = { inline_data: { mime_type: String(m.audio.mime_type || 'audio/ogg').split(';')[0], data: await bajarMedia(m.audio.id) } };
    } else {
      await responder(para, '🤔 Mandame un texto o un audio con el gasto.\nEj: "gasté 12 lucas en el súper"');
      return;
    }

    const uidUser = await miUsuario();
    if (!uidUser) { await responder(para, '⚠️ No sé a qué cuenta cargar. Configurá GASTOS_USER_ID en los secrets de Supabase.'); return; }
    const { data: fila, error } = await sb.from(TABLA).select('datos').eq('user_id', uidUser).single();
    if (error || !fila) { await responder(para, '⚠️ No encontré tus datos. Entrá una vez a la app para crearlos.'); return; }
    const d0 = fila.datos || {};
    if ((d0.movs || []).some((x: Doc) => x.wid === m.id)) return; // Meta reintentó un aviso que ya procesé

    const r = await interpretar(parte, d0, m.type === 'audio');
    const oido = m.type === 'audio' && r.transcripcion ? `🎙️ _"${r.transcripcion}"_\n\n` : '';
    const hoy = hoyAR(), mes = hoy.slice(0, 7);
    const pieMes = (d: Doc) => {
      const t = totales(d, mes);
      return `📊 ${MESES[+mes.slice(5) - 1][0].toUpperCase() + MESES[+mes.slice(5) - 1].slice(1)}: llevás ${plata(t.g)} gastados` + (t.i ? ` · te quedan ${plata(t.i - t.g)}` : '');
    };

    if (r.accion === 'cargar' && Array.isArray(r.movimientos) && r.movimientos.length) {
      const nuevos: Doc[] = [];
      let repetido = false;
      const d = await modificar(uidUser, (doc) => {
        if (doc.movs.some((x: Doc) => x.wid === m.id)) { repetido = true; return; }
        r.movimientos.forEach((x: Doc, k: number) => {
          const monto = Math.round(Number(x.monto) * 100) / 100;
          if (!(monto > 0)) return;
          const t = x.tipo === 'i' ? 'i' : 'g';
          const L = (t === 'i' ? doc.catsI : doc.cats) || [];
          const cat = L.some((c: Doc) => c.id === x.cat) ? x.cat : (L.find((c: Doc) => c.id === 'otros') || L[0] || { id: 'otros' }).id;
          const fecha = /^\d{4}-\d{2}-\d{2}$/.test(x.fecha || '') && x.fecha <= hoy ? x.fecha : hoy;
          const mov = { id: uid(), t, monto, cat, fecha, desc: String(x.desc || '').trim().slice(0, 80), ts: Date.now() + k, origen: 'wpp', wid: m.id };
          doc.movs.push(mov);
          nuevos.push(mov);
        });
      });
      if (repetido) return;
      if (!nuevos.length) { await responder(para, oido + '🤔 No encontré un monto. Probá: "gasté 5000 en nafta"'); return; }
      const lineas = nuevos.map((x) => {
        const c = catDe(d, x.t, x.cat);
        return `${x.t === 'g' ? '💸' : '💰'} ${c.e} ${c.n}${x.desc ? ' · ' + x.desc : ''} · *${plata(x.monto)}*${x.fecha !== hoy ? ' (' + x.fecha.slice(8) + '/' + x.fecha.slice(5, 7) + ')' : ''}`;
      });
      await responder(para, oido + '✅ Anoté:\n' + lineas.join('\n') + '\n\n' + pieMes(d) + '\n\n_Si algo quedó mal, decime "borrá el último"._');
      return;
    }

    if (r.accion === 'borrar_ultimo') {
      let borrado: Doc = null;
      const d = await modificar(uidUser, (doc) => {
        const wpp = doc.movs.filter((x: Doc) => x.origen === 'wpp').sort((a: Doc, b: Doc) => (b.ts || 0) - (a.ts || 0));
        if (!wpp.length) return;
        const wid = wpp[0].wid; // si el último mensaje cargó varios, los borro todos juntos
        borrado = doc.movs.filter((x: Doc) => x.origen === 'wpp' && x.wid === wid);
        doc.movs = doc.movs.filter((x: Doc) => !(x.origen === 'wpp' && x.wid === wid));
      });
      if (!borrado || !borrado.length) { await responder(para, oido + '🤷 No hay nada cargado por WhatsApp para borrar.'); return; }
      await responder(para, oido + '🗑️ Borré:\n' + borrado.map((x: Doc) => `${catDe(d, x.t, x.cat).e} ${x.desc || catDe(d, x.t, x.cat).n} · ${plata(x.monto)}`).join('\n') + '\n\n' + pieMes(d));
      return;
    }

    if (r.accion === 'resumen') {
      const t = totales(d0, mes);
      const top = Object.entries(t.cat).sort((a, b) => b[1] - a[1]).slice(0, 3)
        .map(([id, v]) => { const c = catDe(d0, 'g', id); return `${c.e} ${c.n}: ${plata(v)}`; }).join('\n');
      await responder(para, oido + `📊 *${MESES[+mes.slice(5) - 1]}*\n💰 Entró: ${plata(t.i)}\n💸 Gastaste: ${plata(t.g)}\n🐷 Te queda: ${plata(t.i - t.g)}` + (top ? '\n\n🔝 Donde más gastaste:\n' + top : ''));
      return;
    }

    await responder(para, oido + (r.respuesta || '👋 Mandame un gasto por texto o audio, ej: "gasté 12 lucas en el súper". También podés preguntarme "¿cómo vengo este mes?"'));
  } catch (e) {
    console.error('error procesando', e);
    await responder(para, '⚠️ Algo falló: ' + (e instanceof Error ? e.message : String(e)));
  }
}

// ---------- servidor ----------
Deno.serve(async (req) => {
  const url = new URL(req.url);
  if (req.method === 'GET') {
    // verificación del webhook que hace Meta una sola vez al configurarlo
    if (url.searchParams.get('hub.mode') === 'subscribe' && url.searchParams.get('hub.verify_token') === WPP_VERIFY) {
      return new Response(url.searchParams.get('hub.challenge') ?? '', { status: 200 });
    }
    return new Response('forbidden', { status: 403 });
  }
  if (req.method !== 'POST') return new Response('ok');
  const body = await req.text();
  if (!(await firmaOk(req, body))) return new Response('firma inválida', { status: 401 });
  let data: Doc;
  try { data = JSON.parse(body); } catch { return new Response('ok'); }
  const msgs = (data?.entry ?? []).flatMap((e: Doc) => (e.changes ?? []).flatMap((c: Doc) => c.value?.messages ?? []));
  // respondo 200 enseguida para que Meta no reintente; el trabajo sigue en segundo plano
  const trabajo = (async () => { for (const m of msgs) await procesarMensaje(m); })();
  // deno-lint-ignore no-explicit-any
  const rt = (globalThis as any).EdgeRuntime;
  if (rt?.waitUntil) rt.waitUntil(trabajo); else await trabajo;
  return new Response('ok');
});
