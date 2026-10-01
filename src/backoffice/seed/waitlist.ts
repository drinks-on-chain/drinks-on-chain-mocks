import { sha256Hex } from '../../shared/crypto'
import { day, isoAt } from '../../shared/dates'
import { uid } from '../../shared/uuid'
import type { WaitlistEntry, WaitlistInterest, WaitlistProduces, WaitlistStatus } from '../schemas/waitlist'

// Lista de espera de los fixtures (`fixtures/backoffice/waitlist.json`, contrato O1b): 52
// inscripciones (38 consumidores y 14 bodegas) de los días previos al reloj de referencia
// (2026-09-25 12:00 UTC), la mayoría del evento `tarija-2026` (19 a 21 de septiembre). Personas y
// bodegas ficticias; correos en dominios `example.*`. Las posiciones salen del orden de llegada
// dentro de cada tipo, como en el backend.

const STAFF = { valeria: 'Valeria Méndez', camila: 'Camila Torrez', jorge: 'Jorge Salinas' } as const

/** Día y hora (UTC) de septiembre de 2026: `'19 14:12'`. */
function at(stamp: string): string {
  const match = /^(\d{2}) (\d{2}):(\d{2})$/.exec(stamp)
  if (!match) throw new Error(`Fecha de la lista de espera inválida: ${stamp}`)
  return isoAt(day(2026, 9, Number(match[1])), Number(match[2]), Number(match[3]))
}

type PhoneStyle = 'none' | 'intl' | 'local'

/** Celular boliviano determinista (8 dígitos que empiezan por 7) a partir del correo. */
function phoneFor(email: string, style: PhoneStyle): string | null {
  if (style === 'none') return null
  const digits = String(parseInt(sha256Hex(`waitlist-phone:${email}`).slice(0, 8), 16) % 10_000_000).padStart(7, '0')
  return style === 'intl' ? `+591 7${digits}` : `7${digits}`
}

interface Follow {
  status: WaitlistStatus
  /** Quién lo marcó como contactado y cuándo (`null` si nunca se contactó). */
  contacted?: [by: keyof typeof STAFF, at: string]
  notes?: string
}

interface Row {
  at: string
  fullName: string
  email: string
  phone: PhoneStyle
  source: string | null
  locale?: 'en'
  message?: string
  follow?: Follow
}
interface ConsumerRow extends Row {
  city: string | null
  interest: WaitlistInterest | null
}
interface WineryRow extends Row {
  wineryName: string
  region: string | null
  produces: WaitlistProduces | null
}

const EVENT = 'tarija-2026'

const CONSUMERS: ConsumerRow[] = [
  {
    at: '12 15:10', fullName: 'Lucía Fernández Rojas', email: 'lucia.fernandez@example.com', phone: 'intl', city: 'Tarija', interest: 'BOTH', source: null,
    follow: { status: 'CONTACTED', contacted: ['valeria', '15 14:00'], notes: 'Quiere enterarse de la primera preventa de singani.' },
  },
  { at: '13 13:25', fullName: 'Marcelo Quiroga', email: 'marcelo.quiroga@example.org', phone: 'none', city: 'Tarija', interest: 'WINE', source: 'instagram' },
  { at: '13 22:02', fullName: 'Daniela Mamani Choque', email: 'daniela.mamani@example.net', phone: 'local', city: 'La Paz', interest: 'SINGANI', source: 'instagram' },
  {
    at: '14 16:48', fullName: 'José Luis Vargas', email: 'joseluis.vargas@example.com', phone: 'none', city: 'Santa Cruz de la Sierra', interest: 'BOTH', source: null,
    follow: { status: 'DISCARDED', notes: 'Correo rebotado.' },
  },
  { at: '15 14:30', fullName: 'Carla Gutiérrez', email: 'carla.gutierrez@example.org', phone: 'intl', city: 'Cochabamba', interest: 'WINE', source: 'boletin' },
  {
    at: '16 01:12', fullName: 'Rodrigo Aramayo', email: 'rodrigo.aramayo@example.net', phone: 'intl', city: 'Tarija', interest: 'SINGANI', source: 'instagram',
    follow: { status: 'CONTACTED', contacted: ['valeria', '18 15:00'], notes: 'Pregunta por envíos a Santa Cruz.' },
  },
  { at: '17 18:20', fullName: 'Paola Condori', email: 'paola.condori@example.com', phone: 'local', city: 'El Alto', interest: 'BOTH', source: 'instagram' },
  { at: '18 12:45', fullName: 'Fernando Zeballos', email: 'fernando.zeballos@example.org', phone: 'none', city: 'Sucre', interest: 'WINE', source: 'boletin' },
  { at: '19 14:12', fullName: 'Andrea Castillo Paz', email: 'andrea.castillo@example.net', phone: 'intl', city: 'Tarija', interest: 'BOTH', source: EVENT },
  { at: '19 14:37', fullName: 'Wilson Tolaba', email: 'wilson.tolaba@example.com', phone: 'local', city: 'San Lorenzo', interest: 'SINGANI', source: EVENT },
  {
    at: '19 15:05', fullName: 'Gabriela Arce', email: 'gabriela.arce@example.org', phone: 'intl', city: 'Tarija', interest: 'WINE', source: EVENT,
    follow: { status: 'CONTACTED', contacted: ['camila', '22 14:00'], notes: 'Pidió que le avisemos por WhatsApp.' },
  },
  { at: '19 16:22', fullName: 'Luis Alberto Flores', email: 'luisalberto.flores@example.net', phone: 'none', city: 'Potosí', interest: 'SINGANI', source: EVENT },
  { at: '19 17:48', fullName: 'Natalia Vaca Díez', email: 'natalia.vacadiez@example.com', phone: 'intl', city: 'Santa Cruz de la Sierra', interest: 'WINE', source: EVENT },
  { at: '19 19:03', fullName: 'Óscar Segovia', email: 'oscar.segovia@example.org', phone: 'local', city: 'Tarija', interest: 'BOTH', source: EVENT },
  { at: '19 22:16', fullName: 'Mariana Ruiz', email: 'mariana.ruiz@example.net', phone: 'none', city: 'Cochabamba', interest: 'WINE', source: EVENT },
  {
    at: '20 00:41', fullName: 'Álvaro Baldiviezo', email: 'alvaro.baldiviezo@example.com', phone: 'local', city: 'Tarija', interest: 'SINGANI', source: EVENT,
    follow: { status: 'DISCARDED', notes: 'Pidió darse de baja de la lista.' },
  },
  { at: '20 14:08', fullName: 'Jimena Ortiz', email: 'jimena.ortiz@example.org', phone: 'intl', city: 'La Paz', interest: 'BOTH', source: EVENT },
  { at: '20 14:50', fullName: 'Sergio Cardozo', email: 'sergio.cardozo@example.net', phone: 'none', city: 'Yacuiba', interest: 'SINGANI', source: EVENT },
  { at: '20 16:33', fullName: 'Valentina Michel', email: 'valentina.michel@example.com', phone: 'intl', city: 'Tarija', interest: 'WINE', source: EVENT, message: 'Me interesan los vinos de altura para regalar en fin de año.' },
  { at: '20 17:20', fullName: 'Diego Camacho', email: 'diego.camacho@example.org', phone: 'local', city: 'Oruro', interest: 'BOTH', source: EVENT },
  {
    at: '20 18:44', fullName: 'Claudia Jurado', email: 'claudia.jurado@example.net', phone: 'intl', city: 'Tarija', interest: 'WINE', source: EVENT,
    follow: { status: 'CONTACTED', contacted: ['camila', '23 14:30'] },
  },
  {
    at: '20 21:27', fullName: 'Mauricio Soliz', email: 'mauricio.soliz@example.com', phone: 'intl', city: 'Sucre', interest: 'SINGANI', source: EVENT,
    follow: { status: 'DISCARDED', contacted: ['camila', '23 16:00'], notes: 'Contactado: por ahora no le interesa.' },
  },
  { at: '20 23:55', fullName: 'Fabiola Aguirre', email: 'fabiola.aguirre@example.org', phone: 'none', city: 'Tarija', interest: 'BOTH', source: EVENT },
  { at: '21 14:19', fullName: 'Ronald Chambi', email: 'ronald.chambi@example.net', phone: 'local', city: 'La Paz', interest: 'SINGANI', source: EVENT },
  { at: '21 15:02', fullName: 'Silvia Gareca', email: 'silvia.gareca@example.com', phone: 'intl', city: 'Padcaya', interest: 'WINE', source: EVENT },
  {
    at: '21 16:36', fullName: 'Emily Carter', email: 'emily.carter@example.org', phone: 'none', city: 'Tarija', interest: 'BOTH', source: EVENT, locale: 'en',
    message: 'Visiting Tarija for the harvest festival. Do you ship abroad?',
  },
  { at: '21 18:11', fullName: 'Hernán Cuéllar', email: 'hernan.cuellar@example.net', phone: 'intl', city: 'Santa Cruz de la Sierra', interest: 'WINE', source: EVENT },
  {
    at: '21 20:29', fullName: 'Rocío Espinoza', email: 'rocio.espinoza@example.com', phone: 'local', city: 'Tarija', interest: 'SINGANI', source: EVENT,
    follow: { status: 'CONTACTED', contacted: ['valeria', '24 15:10'] },
  },
  { at: '22 13:40', fullName: 'Gonzalo Miranda', email: 'gonzalo.miranda@example.org', phone: 'none', city: 'Cochabamba', interest: 'BOTH', source: 'qr-cata' },
  { at: '22 19:22', fullName: 'Thomas Becker', email: 'thomas.becker@example.net', phone: 'intl', city: 'Santa Cruz de la Sierra', interest: 'WINE', source: EVENT, locale: 'en' },
  { at: '23 14:05', fullName: 'Verónica Ávila', email: 'veronica.avila@example.com', phone: 'local', city: 'Tarija', interest: 'WINE', source: EVENT },
  { at: '23 17:31', fullName: 'Limbert Colque', email: 'limbert.colque@example.org', phone: 'intl', city: 'Camargo', interest: 'SINGANI', source: 'qr-cata', message: 'Probé el singani en la cata de Camargo y quiero comprar una caja.' },
  { at: '24 02:14', fullName: 'Alejandra Sánchez', email: 'alejandra.sanchez@example.net', phone: 'none', city: 'Tarija', interest: 'BOTH', source: EVENT },
  { at: '24 13:18', fullName: 'Pablo Trigo', email: 'pablo.trigo@example.com', phone: 'intl', city: 'Tarija', interest: 'WINE', source: EVENT },
  { at: '24 18:09', fullName: 'Carmen Rosa Llanos', email: 'carmenrosa.llanos@example.org', phone: 'local', city: 'Villa Abecia', interest: 'SINGANI', source: 'qr-cata' },
  { at: '24 21:56', fullName: 'Ignacio Paredes', email: 'ignacio.paredes@example.net', phone: 'none', city: null, interest: null, source: 'instagram' },
  { at: '25 01:47', fullName: 'Brenda Velásquez', email: 'brenda.velasquez@example.com', phone: 'intl', city: 'Bermejo', interest: 'WINE', source: EVENT },
  { at: '25 10:22', fullName: 'Julio César Molina', email: 'juliocesar.molina@example.org', phone: 'local', city: 'Tarija', interest: 'SINGANI', source: null },
]

const WINERIES: WineryRow[] = [
  {
    at: '12 19:40', wineryName: 'Bodega Parral del Abuelo', fullName: 'Edgar Tolaba Gareca', email: 'parraldelabuelo@example.com', phone: 'intl',
    region: 'Valle Central de Tarija · San Lorenzo', produces: 'WINE', source: null,
    message: 'Bodega familiar con 3 ha de parral; elaboramos vino patero.',
    follow: { status: 'CONTACTED', contacted: ['valeria', '16 15:30'], notes: 'Llamada hecha: interesados, piden una visita en octubre.' },
  },
  {
    at: '14 20:15', wineryName: 'Viñedos Cañón Colorado', fullName: 'Mirtha Arancibia', email: 'canoncolorado@example.org', phone: 'intl',
    region: 'Valle de Cinti · Camargo', produces: 'BOTH', source: 'boletin',
    follow: { status: 'CONTACTED', contacted: ['camila', '17 14:10'] },
  },
  {
    at: '16 14:55', wineryName: 'Destilería El Churqui', fullName: 'Nelson Baldiviezo', email: 'elchurqui@example.net', phone: 'local',
    region: 'Valle Central de Tarija · Uriondo', produces: 'SINGANI', source: null,
    message: 'Destilamos singani de Moscatel de Alejandría desde 2019.',
  },
  {
    at: '18 16:30', wineryName: 'Bodega Quebrada Honda', fullName: 'Teresa Michel', email: 'quebradahonda@example.com', phone: 'none',
    region: 'Valle Central de Tarija · Padcaya', produces: 'WINE', source: null,
    follow: { status: 'DISCARDED', notes: 'No elabora: revende vino de terceros.' },
  },
  {
    at: '19 15:40', wineryName: 'Viña Santa Rosa de Paicho', fullName: 'Rubén Segovia', email: 'santarosadepaicho@example.org', phone: 'intl',
    region: 'Valle de Paicho', produces: 'BOTH', source: EVENT,
    follow: { status: 'CONTACTED', contacted: ['valeria', '22 16:20'], notes: 'Reunión agendada para el 30-09.' },
  },
  {
    at: '19 20:30', wineryName: 'Bodega Los Ceibos de Chaguaya', fullName: 'Marlene Cardozo', email: 'losceibos@example.net', phone: 'intl',
    region: 'Valle Central de Tarija · Chaguaya', produces: 'WINE', source: EVENT,
  },
  {
    at: '20 15:15', wineryName: 'Destilería Molle Pampa', fullName: 'Freddy Aparicio', email: 'mollepampa@example.com', phone: 'local',
    region: 'Valle de Cinti · Villa Abecia', produces: 'SINGANI', source: EVENT,
    follow: { status: 'CONTACTED', contacted: ['jorge', '23 15:00'], notes: 'Envían el registro SENASAG esta semana.' },
  },
  {
    at: '20 19:10', wineryName: 'Vinos de Altura Sella Méndez', fullName: 'Roxana Méndez', email: 'sellamendez@example.org', phone: 'intl',
    region: 'Valle Central de Tarija · Sella', produces: 'WINE', source: EVENT,
  },
  {
    at: '21 15:48', wineryName: 'Viñas de Tomayapo', fullName: 'Abel Colque', email: 'vinasdetomayapo@example.net', phone: 'intl',
    region: 'Valle de Tomayapo', produces: 'BOTH', source: EVENT,
    follow: { status: 'CONTACTED', contacted: ['valeria', '24 14:45'], notes: 'Tienen 5 ha a 2.300 msnm; quieren trazabilidad desde la vendimia.' },
  },
  {
    at: '21 21:05', wineryName: 'Singani Artesanal Río San Juan del Oro', fullName: 'Elmer Vidaurre', email: 'riosanjuandeloro@example.com', phone: 'local',
    region: 'Valle de Cinti · Las Carreras', produces: 'SINGANI', source: EVENT,
  },
  {
    at: '22 20:10', wineryName: 'Bodega Tierra Roja de Samaipata', fullName: 'Karina Suárez', email: 'tierraroja@example.org', phone: 'intl',
    region: 'Valles cruceños · Samaipata', produces: 'WINE', source: null,
    message: 'Viñedo joven a 1.750 msnm; primera vendimia comercial en 2027.',
  },
  {
    at: '23 18:47', wineryName: 'Bodega El Carmen de Luribay', fullName: 'Javier Limachi', email: 'elcarmendeluribay@example.net', phone: 'none',
    region: 'Valle de Luribay', produces: 'BOTH', source: 'instagram',
  },
  {
    at: '24 15:42', wineryName: 'Viñedos Pampa Grande de Camargo', fullName: 'Sandra Villena', email: 'pampagrande@example.com', phone: 'intl',
    region: 'Valle de Cinti · Camargo', produces: 'WINE', source: EVENT,
  },
  {
    at: '25 00:30', wineryName: 'Bodega Cepas de San Roque', fullName: 'Ramiro Ichazo', email: 'cepasdesanroque@example.org', phone: 'local',
    region: null, produces: 'OTHER', source: null,
    message: 'Elaboramos licores de frutas y un vino de mesa.',
  },
]

type Specific = Pick<WaitlistEntry, 'city' | 'interest' | 'wineryName' | 'region' | 'produces'>

/** Inscripción con las claves en el orden de `WaitlistEntryDto`. */
function entry(type: WaitlistEntry['type'], position: number, row: Row, specific: Specific): WaitlistEntry {
  const createdAt = at(row.at)
  const f = row.follow
  return {
    id: uid(`waitlist:${type}:${position}`),
    type,
    position,
    status: f?.status ?? 'NEW',
    fullName: row.fullName,
    email: row.email,
    phone: phoneFor(row.email, row.phone),
    city: specific.city,
    interest: specific.interest,
    wineryName: specific.wineryName,
    region: specific.region,
    produces: specific.produces,
    message: row.message ?? null,
    locale: row.locale ?? 'es',
    source: row.source,
    consentAt: createdAt,
    createdAt,
    contactedAt: f?.contacted ? at(f.contacted[1]) : null,
    contactedBy: f?.contacted ? STAFF[f.contacted[0]] : null,
    notes: f?.notes ?? null,
  }
}

/** Inscripciones de los fixtures, más recientes primero (como `GET /v1/platform/waitlist`). */
export function generateWaitlistFixtures(): WaitlistEntry[] {
  const consumers = CONSUMERS.map((row, i) =>
    entry('CONSUMER', i + 1, row, { city: row.city, interest: row.interest, wineryName: null, region: null, produces: null }),
  )
  const wineries = WINERIES.map((row, i) =>
    entry('WINERY', i + 1, row, { city: null, interest: null, wineryName: row.wineryName, region: row.region, produces: row.produces }),
  )
  // La posición es el orden de llegada dentro de cada tipo: las filas deben estar en orden.
  for (const list of [consumers, wineries]) {
    for (let i = 1; i < list.length; i++) {
      if (list[i]!.createdAt <= list[i - 1]!.createdAt) throw new Error(`Lista de espera desordenada: ${list[i]!.email}`)
    }
  }
  return [...consumers, ...wineries].sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : a.id < b.id ? -1 : 1))
}
