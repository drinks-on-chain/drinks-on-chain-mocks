import { addMonthsClamped, day, dayFromIso, dayParts, isoAt, REFERENCE_DAY, type Day } from '../../shared/dates'
import { uid } from '../../shared/uuid'
import { buildAuthResponse, buildPublicPassport } from '../derive'
import { deriveLotViews, deriveRestStatus } from '../lot-view'
import { WINERY_CODES } from '../catalog'
import type {
  AuthResponse,
  BatchLabAnalysisResponse,
  BottlingBatchResponse,
  EnologicalTreatment,
  FermentationLog,
  FermentationTankResponse,
  HarvestBatchResponse,
  LotView,
  MockUser,
  ProductionBatchResponse,
  PublicPassport,
  RestStatusResponse,
  TerroirResponse,
  WalletResponse,
  WineAgingResponse,
  WineryResponse,
} from '../schemas'
import { PyRandom, pyRound } from './py-random'

// Generador determinista de los fixtures del ERP: puerto línea a línea de
// `docs/mocks/erp/generate.py` (copia en test/reference/generate.py). La salida es igual,
// objeto a objeto, a la de Python: mismo Mersenne Twister, mismos UUID v5, mismas fechas.
// Si cambias algo aquí, cambia también el script de Python y regenera la referencia.

const TODAY = dayFromIso(REFERENCE_DAY)
const addDays = (d: Day, n: number): Day => d + n

function gkey(seed: string): string {
  const r = new PyRandom(seed)
  const alphabet = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567']
  let s = 'G'
  for (let i = 0; i < 55; i++) s += r.choice(alphabet)
  return s
}

function txhash(seed: string): string {
  const r = new PyRandom(seed)
  const hex = [...'0123456789abcdef']
  let s = ''
  for (let i = 0; i < 64; i++) s += r.choice(hex)
  return s
}

/** Nombre de archivo → contenido, en el orden en que los escribe `generate.py`. */
export interface ErpFixtureSet {
  'wineries.json': WineryResponse[]
  'users.json': MockUser[]
  'wallets.json': WalletResponse[]
  'auth-login.json': Record<string, AuthResponse>
  'terroirs.json': TerroirResponse[]
  'harvest-batches.json': HarvestBatchResponse[]
  'fermentation-tanks.json': FermentationTankResponse[]
  'fermentation-logs.json': FermentationLog[]
  'enological-treatments.json': EnologicalTreatment[]
  'wine-aging.json': WineAgingResponse[]
  'production-batches.json': ProductionBatchResponse[]
  'production-rest-status.json': RestStatusResponse[]
  'bottling.json': BottlingBatchResponse[]
  'lab-analyses.json': BatchLabAnalysisResponse[]
  'traceability-public.json': Record<string, PublicPassport>
  'lots-view.json': LotView[]
}
export type ErpFixtureName = keyof ErpFixtureSet

export function generateErpFixtures(): ErpFixtureSet {
  const rng = new PyRandom(20260925)

  // -------------------------------------------------------------------------
  // 1. Bodegas (WineryResponseDto)
  // -------------------------------------------------------------------------
  const WINERIES = [
    { key: 'altos', legalName: 'Altos de Calamuchita S.R.L.', commercialName: 'Bodega Altos de Calamuchita',
      beverageCategory: 'WINERY', taxIdNit: '1023456019', senasagSanitaryReg: '08-01-03-01-0142',
      geographicRegion: 'Valle Central de Tarija · Santa Ana', address: 'Camino a Calamuchita km 9, Santa Ana la Nueva, Tarija',
      contactEmail: 'contacto@altos.test', contactPhone: '+59146650142', certificationStatus: 'ACTIVE',
      approvedAt: day(2026, 3, 2), createdAt: day(2026, 2, 20) },
    { key: 'cintiviejo', legalName: 'Destilería Cinti Viejo S.A.', commercialName: 'Destilería Cinti Viejo',
      beverageCategory: 'DISTILLERY', taxIdNit: '2087654031', senasagSanitaryReg: '01-02-01-03-0077',
      geographicRegion: 'Valle de Cinti · Camargo', address: 'Av. del Singani 45, Camargo, Chuquisaca',
      contactEmail: 'contacto@cintiviejo.test', contactPhone: '+59146930077', certificationStatus: 'ACTIVE',
      approvedAt: day(2026, 1, 15), createdAt: day(2026, 1, 8) },
    { key: 'guadalquivir', legalName: 'Viñedos del Guadalquivir S.R.L.', commercialName: 'Viñedos del Guadalquivir',
      beverageCategory: 'WINERY', taxIdNit: '3011223344', senasagSanitaryReg: null,
      geographicRegion: 'Valle Central de Tarija · Concepción', address: null,
      contactEmail: 'hola@guadalquivir.test', contactPhone: '+59171223344', certificationStatus: 'PENDING',
      approvedAt: null, createdAt: day(2026, 9, 18) },
    { key: 'uriondo', legalName: 'Casa Uriondo Ltda.', commercialName: 'Casa Uriondo',
      beverageCategory: 'DISTILLERY', taxIdNit: '4099887766', senasagSanitaryReg: '08-01-03-02-0009',
      geographicRegion: 'Valle Central de Tarija · Uriondo', address: 'Plaza principal s/n, Uriondo',
      contactEmail: 'casa@uriondo.test', contactPhone: '+59146660009', certificationStatus: 'SUSPENDED',
      approvedAt: day(2025, 11, 3), createdAt: day(2025, 10, 20) },
  ] as const

  const wineries: WineryResponse[] = []
  for (const w of WINERIES) {
    const active = w.certificationStatus === 'ACTIVE' || w.certificationStatus === 'SUSPENDED'
    wineries.push({
      id: uid(`winery:${w.key}`),
      legalName: w.legalName,
      commercialName: w.commercialName,
      beverageCategory: w.beverageCategory,
      taxIdNit: w.taxIdNit,
      senasagSanitaryReg: w.senasagSanitaryReg,
      geographicRegion: w.geographicRegion,
      countryCode: 'BO',
      address: w.address,
      contactEmail: w.contactEmail,
      contactPhone: w.contactPhone,
      logoUrl: `/mocks/uploads/logos/${w.key}.png`,
      stellarPublicKey: active ? gkey(`winery-wallet:${w.key}`) : null,
      onchainProducerId: active ? `PROD_BO_${w.taxIdNit}` : null,
      onchainRegisterTxHash: active ? txhash(`register:${w.key}`) : null,
      isExportCertified: w.key === 'cintiviejo',
      certificationStatus: w.certificationStatus,
      approvedAt: w.approvedAt !== null ? isoAt(w.approvedAt, 10) : null,
      createdAt: isoAt(w.createdAt, 9),
      members: [],
    })
  }
  const W: Record<string, WineryResponse> = {}
  for (const w of WINERIES) W[w.key] = wineries.find((x) => x.id === uid(`winery:${w.key}`))!
  const wineryKeyOf = (wineryId: string) => Object.keys(W).find((k) => W[k]!.id === wineryId)!

  // -------------------------------------------------------------------------
  // 2. Usuarios (UserProfileResponseDto) y billeteras (WalletResponseDto)
  // -------------------------------------------------------------------------
  type Person = [string, string, string, MockUser['userRole'], string | null, 'OWNER' | 'ENOLOGIST' | 'AGRONOMIST' | 'OPERATOR' | null, string | null, string]
  const PEOPLE: Person[] = [
    ['admin', 'gestor@drinksonchain.test', 'Ana Gutiérrez', 'PLATFORM_ADMIN', null, null, null, '+59170000001'],
    ['soporte', 'soporte@drinksonchain.test', 'Pablo Rivera', 'PLATFORM_ADMIN', null, null, null, '+59170000002'],
    ['altos_admin', 'admin@altos.test', 'Martín Calamuchita', 'WINERY_ADMIN', 'altos', 'OWNER', null, '+59171000101'],
    ['altos_enologa', 'enologa@altos.test', 'Lic. Carla Villarroel', 'ENOLOGIST', 'altos', 'ENOLOGIST', 'COL-ENOL-TAR-118', '+59171000102'],
    ['altos_agronomo', 'agronomo@altos.test', 'Ing. Diego Paredes', 'AGRONOMIST', 'altos', 'AGRONOMIST', 'CIA-TAR-522', '+59171000103'],
    ['altos_operario', 'operario@altos.test', 'Mario Quispe', 'ENOLOGIST', 'altos', 'OPERATOR', null, '+59171000104'],
    ['cvj_admin', 'admin@cintiviejo.test', 'Rosa Camargo', 'WINERY_ADMIN', 'cintiviejo', 'OWNER', null, '+59172000201'],
    ['cvj_enologa', 'enologa@cintiviejo.test', 'Lic. Lucía Rojas', 'ENOLOGIST', 'cintiviejo', 'ENOLOGIST', 'COL-ENOL-CHQ-041', '+59172000202'],
    ['cvj_agronomo', 'agronomo@cintiviejo.test', 'Ing. Tomás Flores', 'AGRONOMIST', 'cintiviejo', 'AGRONOMIST', 'CIA-CHQ-207', '+59172000203'],
    ['cvj_operario', 'operario@cintiviejo.test', 'Rubén Flores', 'ENOLOGIST', 'cintiviejo', 'OPERATOR', null, '+59172000204'],
    ['vgq_admin', 'gerencia@guadalquivir.test', 'Elena Vaca', 'WINERY_ADMIN', 'guadalquivir', 'OWNER', null, '+59173000301'],
    ['maria', 'maria@tribu.test', 'María Fernández', 'CONSUMER', null, null, null, '+59174000401'],
    ['carlos', 'carlos@tribu.test', 'Carlos Mamani', 'CONSUMER', null, null, null, '+59174000402'],
    ['juan_pos', 'cajero.lacava@drinksonchain.test', 'Juan Pérez', 'POS_OPERATOR', null, null, null, '+59175000501'],
  ]

  const users: MockUser[] = []
  const wallets: WalletResponse[] = []
  for (const [key, email, name, role, wkey, mrole, lic, phone] of PEOPLE) {
    const userId = uid(`user:${key}`)
    const created = addDays(day(2026, 1, 10), rng.randint(0, 200))
    const wallet: WalletResponse = {
      id: uid(`wallet:${key}`),
      userId,
      wineryId: wkey ? W[wkey]!.id : null,
      stellarPublicAddress: gkey(`user-wallet:${key}`),
      walletType: 'CUSTODIAL',
      walletPurpose: wkey ? 'PRODUCER_SIGNING' : 'CONSUMER_NFT',
      isPrimary: true,
      createdAt: isoAt(created, 9, 5),
    }
    wallets.push(wallet)
    const memberships: MockUser['wineryMemberships'] = []
    if (wkey && mrole) {
      const joined = addDays(created, 1)
      memberships.push({
        wineryId: W[wkey]!.id,
        wineryName: W[wkey]!.commercialName,
        memberRole: mrole,
        professionalLicenseNumber: lic,
        isActive: true,
        joinedAt: isoAt(joined, 10),
      })
      W[wkey]!.members!.push({
        id: uid(`member:${key}`),
        userId,
        fullName: name,
        email,
        memberRole: mrole,
        professionalLicenseNumber: lic,
        isActive: true,
        joinedAt: isoAt(joined, 10),
      })
    }
    users.push({
      id: userId,
      email,
      fullName: name,
      userRole: role,
      phoneNumber: phone,
      preferredLocale: 'es',
      isActive: true,
      lastLoginAt: isoAt(addDays(TODAY, -rng.randint(0, 6)), 8, 30),
      createdAt: isoAt(created, 9),
      wineryMemberships: memberships,
      primaryWallet: wallet,
      _mock: { key, password: 'demo1234' },
    })
  }
  const auth: Record<string, AuthResponse> = {}
  for (const u of users) auth[u._mock.key] = buildAuthResponse(u)

  // -------------------------------------------------------------------------
  // 3. Terroirs (TerroirResponseDto)
  // -------------------------------------------------------------------------
  type TerroirRow = [string, string, string, string, number, number, number, number, string, string, boolean, string | null]
  const TERROIRS: TerroirRow[] = [
    ['altos_01', 'altos', 'Cuartel 1 · La Angostura', 'CAT-TAR-1101', 6.8, 1860, -21.561, -64.688, 'Tannat', 'Franco-arcilloso con cantos rodados', true, 'Valles Altos de Bolivia'],
    ['altos_02', 'altos', 'Cuartel 2 · Los Sauces', 'CAT-TAR-1102', 4.1, 1875, -21.559, -64.691, 'Moscatel de Alejandría', 'Franco-arenoso', true, 'D.O. Singani'],
    ['altos_03', 'altos', 'Cuartel 3 · El Portillo', 'CAT-TAR-1103', 2.1, 1540, -21.572, -64.67, 'Moscatel de Alejandría', 'Arcilloso profundo', false, null],
    ['altos_04', 'altos', 'Cuartel 4 · Loma Alta', 'CAT-TAR-1104', 3.6, 1910, -21.555, -64.695, 'Syrah', 'Franco con grava', true, 'Valles Altos de Bolivia'],
    ['altos_05', 'altos', 'Cuartel 5 · La Compañía', 'CAT-TAR-1105', 5.0, 1890, -21.558, -64.689, 'Cabernet Sauvignon', 'Franco-arcilloso', true, 'Valles Altos de Bolivia'],
    ['cvj_01', 'cintiviejo', 'Parcela 1 · Los Parrales', 'CAT-CIN-2201', 4.2, 2350, -20.648, -65.225, 'Moscatel de Alejandría', 'Franco-arenoso con grava fluvial', true, 'D.O. Singani'],
    ['cvj_02', 'cintiviejo', 'Parcela 2 · Cañón Viejo', 'CAT-CIN-2202', 3.3, 2410, -20.652, -65.231, 'Moscatel de Alejandría', 'Aluvial calcáreo', true, 'D.O. Singani'],
    ['cvj_03', 'cintiviejo', 'Parcela 3 · Las Carreras', 'CAT-CIN-2203', 2.7, 2280, -20.66, -65.218, 'Vischoqueña', 'Franco-arenoso', true, 'Valles Altos de Bolivia'],
    ['cvj_04', 'cintiviejo', 'Parcela 4 · El Molino', 'CAT-CIN-2204', 1.9, 2320, -20.655, -65.22, 'Moscatel de Alejandría', 'Pedregoso', true, 'D.O. Singani'],
    ['cvj_05', 'cintiviejo', 'Parcela 5 · San Roque', 'CAT-CIN-2205', 3.8, 2390, -20.644, -65.229, 'Negra Criolla', 'Franco', true, 'Valles Altos de Bolivia'],
    ['vgq_01', 'guadalquivir', 'Finca El Rancho · lote A', 'CAT-TAR-3301', 7.2, 1790, -21.43, -64.79, 'Syrah', 'Franco-arcilloso', true, 'Valles Altos de Bolivia'],
  ]
  const terroirs: TerroirResponse[] = []
  TERROIRS.forEach(([key, wkey, name, cad, ha, masl, lat, lon, variety, soil, doOk, doType], i) => {
    terroirs.push({
      id: uid(`terroir:${key}`),
      wineryId: W[wkey]!.id,
      parcelName: name,
      cadastreCode: cad,
      surfaceHectares: ha,
      altitudeMasl: masl,
      latitude: lat,
      longitude: lon,
      geographicPolygonGeojson: {
        type: 'Polygon',
        coordinates: [[
          [lon - 0.002, lat - 0.0015], [lon + 0.002, lat - 0.0015], [lon + 0.002, lat + 0.0015],
          [lon - 0.002, lat + 0.0015], [lon - 0.002, lat - 0.0015],
        ]],
      },
      rawMaterialType: 'uva',
      varietyName: variety,
      soilType: soil,
      irrigationSystem: rng.choice(['Riego por goteo', 'Secano', 'Riego por surcos']),
      isDoEligible: doOk,
      doType,
      doCertificateUrl: doOk ? `/mocks/uploads/certificates/do-${key}.pdf` : null,
      isActive: true,
      createdAt: isoAt(addDays(day(2026, 1, 20), i * 3), 11),
    })
  })
  const TK: Record<string, TerroirResponse> = {}
  for (const [key] of TERROIRS) TK[key] = terroirs.find((t) => t.id === uid(`terroir:${key}`))!

  // -------------------------------------------------------------------------
  // 4. Lotes de vendimia (HarvestBatchResponseDto)
  // -------------------------------------------------------------------------
  type HarvestRow = [string, string, Day, number, number, number, number, number, number, HarvestBatchResponse['phytosanitaryStatus'], string | null]
  const HARVESTS: HarvestRow[] = [
    ['h01', 'cvj_01', day(2026, 3, 4), 18550, 150, 23.4, 3.4, 5.9, 15.8, 'APPROVED', 'cvj_enologa'],
    ['h02', 'cvj_02', day(2025, 3, 10), 15000, 150, 22.4, 3.45, 6.8, 16.5, 'APPROVED', 'cvj_enologa'],
    ['h03', 'cvj_04', day(2025, 3, 18), 9100, 100, 22.9, 3.38, 6.4, 17.0, 'APPROVED', 'cvj_enologa'],
    ['h04', 'cvj_03', day(2025, 2, 26), 7300, 100, 24.1, 3.55, 5.7, 14.2, 'APPROVED', 'cvj_enologa'],
    ['h05', 'cvj_05', day(2026, 3, 12), 6400, 100, 23.0, 3.5, 6.0, 15.0, 'PENDING_INSPECTION', null],
    ['h06', 'altos_01', day(2025, 3, 2), 8500, 100, 24.5, 3.6, 5.8, 14.0, 'APPROVED', 'altos_enologa'],
    ['h07', 'altos_02', day(2026, 3, 9), 12200, 150, 22.8, 3.42, 6.5, 16.1, 'APPROVED', 'altos_enologa'],
    ['h08', 'altos_04', day(2025, 3, 20), 7800, 100, 25.1, 3.65, 5.5, 13.5, 'APPROVED', 'altos_enologa'],
    ['h09', 'altos_05', day(2025, 3, 6), 9900, 100, 24.8, 3.62, 5.6, 14.4, 'APPROVED', 'altos_enologa'],
    ['h10', 'altos_03', day(2026, 3, 15), 4100, 50, 21.2, 3.7, 5.0, 18.0, 'REJECTED', 'altos_enologa'],
    ['h11', 'altos_01', day(2026, 3, 22), 6200, 100, 23.9, 3.58, 5.9, 15.2, 'QUARANTINE', 'altos_agronomo'],
    ['h12', 'altos_02', day(2026, 9, 24), 6200, 100, 0.0, 0.0, 0.0, 16.0, 'PENDING_INSPECTION', null],
  ]
  const harvests: HarvestBatchResponse[] = []
  for (const [key, tkey, intake, gross, tare, brix, ph, acid, temp, status, cert] of HARVESTS) {
    const t = TK[tkey]!
    const slug = t.parcelName.split('·').at(-1)!.trim().split(/\s+/).at(-1)!.toUpperCase()
    const year = dayParts(intake).year
    harvests.push({
      id: uid(`harvest:${key}`),
      wineryId: t.wineryId,
      terroirId: t.id,
      harvestBatchCode: `HARV-${year}-${slug}-${key.slice(-2)}`,
      intakeDate: isoAt(intake, 9, 42),
      harvestYear: year,
      grossWeightKg: gross,
      tareWeightKg: tare,
      netWeightKg: gross - tare,
      brixDegrees: brix,
      initialPh: ph,
      initialAcidityGl: acid,
      temperatureAtIntakeC: temp,
      phytosanitaryStatus: status,
      phytoInspectionPdfUrl:
        status === 'APPROVED' || status === 'REJECTED' || status === 'QUARANTINE'
          ? `/mocks/uploads/inspections/phyto-${key}.pdf`
          : null,
      certifiedByMemberId: cert ? uid(`member:${cert}`) : null,
      notes: rng.choice([
        'Cosecha manual matutina en cajas de 15 kg.',
        'Uva sana, sin botritis.',
        'Ingreso por camión, tara verificada en báscula.',
        null,
      ]),
      createdAt: isoAt(intake, 9, 45),
    })
  }
  const H: Record<string, HarvestBatchResponse> = {}
  for (const [key] of HARVESTS) H[key] = harvests.find((h) => h.id === uid(`harvest:${key}`))!

  // -------------------------------------------------------------------------
  // 5. Tanques (FermentationTankResponseDto) + lecturas + tratamientos
  // -------------------------------------------------------------------------
  type TankRow = [string, string, string, number, number, NonNullable<FermentationTankResponse['destinationType']>, FermentationTankResponse['status'], Day, Day | null]
  const TANKS: TankRow[] = [
    ['t01', 'h01', 'TK-03', 15000, 12100, 'SINGANI_DIST', 'TRANSFERRED', day(2026, 3, 6), day(2026, 4, 14)],
    ['t02', 'h02', 'TK-01', 15000, 10100, 'SINGANI_DIST', 'TRANSFERRED', day(2025, 3, 11), day(2025, 4, 12)],
    ['t03', 'h03', 'TK-02', 10000, 6100, 'SINGANI_DIST', 'TRANSFERRED', day(2025, 3, 19), day(2025, 4, 20)],
    ['t04', 'h04', 'TK-05', 8000, 4900, 'WINE_AGING', 'TRANSFERRED', day(2025, 2, 27), day(2025, 3, 20)],
    ['t05', 'h07', 'TK-04', 10000, 8300, 'WINE_AGING', 'FERMENTING', day(2026, 3, 10), null],
    ['t06', 'h06', 'TK-RED-01', 10000, 5800, 'WINE_AGING', 'TRANSFERRED', day(2025, 3, 3), day(2025, 3, 24)],
    ['t07', 'h08', 'TK-RED-02', 10000, 5300, 'WINE_AGING', 'TRANSFERRED', day(2025, 3, 21), day(2025, 4, 11)],
    ['t08', 'h09', 'TK-RED-03', 12000, 6700, 'WINE_AGING', 'TRANSFERRED', day(2025, 3, 7), day(2025, 3, 28)],
    ['t09', 'h07', 'TK-06', 10000, 0, 'WINE_AGING', 'CLEANED', day(2026, 1, 5), day(2026, 1, 6)],
    ['t10', 'h11', 'TK-07', 8000, 4200, 'OTHER', 'FILLING', day(2026, 9, 24), null],
    ['t11', 'h01', 'TK-08', 8000, 6300, 'SINGANI_DIST', 'COMPLETED', day(2026, 3, 7), day(2026, 4, 2)],
    ['t12', 'h02', 'TK-09', 15000, 0, 'SINGANI_DIST', 'CLEANED', day(2025, 3, 11), day(2025, 4, 13)],
    ['t13', 'h06', 'TK-RED-04', 10000, 0, 'WINE_AGING', 'CLEANED', day(2025, 3, 3), day(2025, 3, 25)],
    ['t14', 'h07', 'TK-10', 5000, 3900, 'WINE_AGING', 'FERMENTING', day(2026, 3, 11), null],
  ]
  const tanks: FermentationTankResponse[] = []
  const logs: FermentationLog[] = []
  const treatments: EnologicalTreatment[] = []
  for (const [key, hkey, code, cap, filled, dest, status, start, end] of TANKS) {
    const h = H[hkey]!
    const tid = uid(`tank:${key}`)
    tanks.push({
      id: tid,
      wineryId: h.wineryId,
      harvestBatchId: h.id,
      tankCode: code,
      capacityLiters: cap,
      material: 'Acero inoxidable AISI 316',
      volumeFilledLiters: filled,
      destinationType: dest,
      status,
      startDate: isoAt(start, 14, 30),
      endDate: end !== null ? isoAt(end, 14, 30) : null,
      createdAt: isoAt(start, 14, 35),
    })
    if (status === 'FERMENTING' || status === 'COMPLETED' || status === 'TRANSFERRED') {
      const last = end ?? TODAY
      const nDays = Math.min(last - start, 24)
      let sg = 1.092
      for (let d = 0; d < nDays; d++) {
        const when = addDays(start, d + 1)
        sg = Math.max(0.992, sg - rng.uniform(0.003, 0.006))
        let temp = 22.0 + rng.uniform(-1.5, 1.5)
        if (key === 't05' && d >= nDays - 3) temp = 27.0 + rng.uniform(0, 0.8) // alerta de temperatura
        const temperatureCelsius = pyRound(temp, 1)
        const specificGravity = pyRound(sg, 3)
        const phValue = pyRound(3.4 + rng.uniform(-0.05, 0.08), 2)
        const co2Observations = rng.choice(['Desprendimiento vigoroso de CO2', 'Fermentación regular', 'Sombrero bien hidratado', null])
        const notes = rng.choice(['Remontado matutino de 20 min', null, null])
        logs.push({
          id: uid(`log:${key}:${d}`),
          fermentationTankId: tid,
          temperatureCelsius,
          specificGravity,
          phValue,
          co2Observations,
          recordedAt: isoAt(when, 8),
          notes,
          recordedByMemberId: uid(`member:${h.wineryId === W.altos!.id ? 'altos_operario' : 'cvj_operario'}`),
        })
      }
      treatments.push({
        id: uid(`treatment:${key}:so2`),
        fermentationTankId: tid,
        treatmentType: 'SO2_ADDITION',
        additiveName: 'Metabisulfito de potasio grado alimentario',
        additiveSupplier: 'Laffort Oenologie',
        dosageAppliedGPerHl: 30.0,
        totalAppliedG: filled ? pyRound((30.0 * filled) / 100, 1) : null,
        regulatoryAuthCode: 'SENASAG-REG-ADD-2024-88',
        appliedAt: isoAt(start, 15),
        notes: 'Sulfitado inicial',
      })
      if (dest === 'WINE_AGING') {
        treatments.push({
          id: uid(`treatment:${key}:nut`),
          fermentationTankId: tid,
          treatmentType: 'NUTRIENT_ADDITION',
          additiveName: 'Fosfato diamónico y levadura Saccharomyces cerevisiae seleccionada',
          additiveSupplier: 'Enartis',
          dosageAppliedGPerHl: 20.0,
          totalAppliedG: filled ? pyRound((20.0 * filled) / 100, 1) : null,
          regulatoryAuthCode: 'SENASAG-REG-ADD-2024-112',
          appliedAt: isoAt(addDays(start, 1), 12),
          notes: 'Adición al primer tercio de fermentación',
        })
      }
    }
  }
  const TN: Record<string, FermentationTankResponse> = {}
  for (const [key] of TANKS) TN[key] = tanks.find((t) => t.id === uid(`tank:${key}`))!

  // -------------------------------------------------------------------------
  // 6. Crianza (WineAgingResponseDto)
  // -------------------------------------------------------------------------
  type AgingRow = [string, string, string, string, number, number, number, Day, WineAgingResponse['agingStatus']]
  const AGING: AgingRow[] = [
    ['a01', 't06', 'Roble francés grano fino (Allier), tostado medio', 'BAR-FR-2024-01', 1, 3375, 12, day(2025, 11, 3), 'AGING'],
    ['a02', 't07', 'Roble americano, tostado medio plus', 'BAR-US-2024-07', 2, 3150, 8, day(2026, 6, 30), 'AGING'],
    ['a03', 't04', 'Roble francés, tostado ligero', 'BAR-FR-2023-11', 3, 2925, 10, day(2025, 4, 1), 'READY'],
    ['a04', 't08', 'Roble francés (Nevers), tostado medio', 'BAR-FR-2023-04', 1, 4050, 12, day(2025, 4, 10), 'BOTTLED'],
  ]
  const agings: WineAgingResponse[] = []
  for (const [key, tkey, mat, code, cycle, liters, months, start, status] of AGING) {
    const t = TN[tkey]!
    agings.push({
      id: uid(`aging:${key}`),
      wineryId: t.wineryId,
      fermentationTankId: t.id,
      containerType: 'Barrica',
      containerMaterial: mat,
      containerCode: code,
      barrelUseCycle: cycle,
      volumeLiters: liters,
      plannedMonths: months,
      lockUntilDate: isoAt(addMonthsClamped(start, months), 0),
      agingStatus: status,
      notes: 'Cava subterránea a 14 °C y 75 % HR',
      createdAt: isoAt(start, 10),
    })
  }
  const AG: Record<string, WineAgingResponse> = {}
  for (const [key] of AGING) AG[key] = agings.find((a) => a.id === uid(`aging:${key}`))!

  // -------------------------------------------------------------------------
  // 7. Destilación (ProductionBatchResponseDto)
  // -------------------------------------------------------------------------
  type DistRow = [string, string, string, Day, Day, number, number, number, number, ProductionBatchResponse['restStatus']]
  const DIST: DistRow[] = [
    ['p01', 't01', 'Alambique de cobre Charentais AL-01', day(2026, 4, 15), day(2026, 4, 16), 12100, 1500, 330, 60.0, 'RESTING'],
    ['p02', 't02', 'Alambique de cobre Charentais AL-01', day(2025, 5, 20), day(2025, 5, 25), 10000, 1750, 570, 70.2, 'BOTTLED'],
    ['p03', 't03', 'Alambique de cobre AL-02', day(2025, 5, 2), day(2025, 5, 4), 6100, 980, 290, 65.4, 'BOTTLED'],
    ['p04', 't11', 'Alambique de cobre AL-02', day(2026, 9, 10), day(2026, 9, 12), 6300, 900, 260, 62.1, 'RESTING'],
    ['p05', 't03', 'Alambique de cobre AL-02', day(2026, 3, 20), day(2026, 3, 22), 3000, 450, 120, 64.0, 'READY'],
  ]
  const productions: ProductionBatchResponse[] = []
  for (const [key, tkey, equip, start, end, vin, vout, waste, abv, status] of DIST) {
    const t = TN[tkey]!
    productions.push({
      id: uid(`production:${key}`),
      wineryId: t.wineryId,
      fermentationTankId: t.id,
      processType: 'SINGANI_DISTILLATION',
      equipmentIdentifier: equip,
      processStartDate: isoAt(start, 0),
      processEndDate: isoAt(end, 0),
      inputVolumeLiters: vin,
      outputVolumeLiters: vout,
      wasteVolumeLiters: waste,
      initialAlcoholPercentage: abv,
      isDoEligible: true,
      mandatoryRestUntil: isoAt(addDays(end, 180), 0),
      restStatus: status,
      additionalParams: {
        headDiscardLiters: pyRound(waste * 0.3),
        heartYieldLiters: vout,
        tailDiscardLiters: pyRound(waste * 0.7),
      },
      notes: 'Destilación lenta a fuego directo con separación estricta de cabezas',
      createdAt: isoAt(start, 10),
    })
  }
  const PR: Record<string, ProductionBatchResponse> = {}
  for (const [key] of DIST) PR[key] = productions.find((p) => p.id === uid(`production:${key}`))!

  const restStatuses = productions.map((p) => deriveRestStatus(p, { today: REFERENCE_DAY }))

  // -------------------------------------------------------------------------
  // 8. Embotellado (BottlingBatchResponseDto)
  // -------------------------------------------------------------------------
  type BottlingRow = [string, 'aging' | 'production', string, BottlingBatchResponse['productType'], number, number | null, number, number, string, Day, boolean, number, string]
  const BOTTLING: BottlingRow[] = [
    ['b01', 'production', 'p02', 'SINGANI', 40.0, 1321, 4080, 75, 'Vidrio extra-flint 750 ml', day(2026, 3, 1), true, 1, 'cvj_enologa'],
    ['b02', 'production', 'p03', 'SINGANI', 40.0, 620, 2140, 75, 'Vidrio flint 750 ml', day(2026, 2, 10), true, 2, 'cvj_enologa'],
    ['b03', 'aging', 'a04', 'WINE', 14.2, null, 5320, 75, 'Bordelesa cónica verde antiguo 750 ml', day(2026, 5, 12), true, 1, 'altos_enologa'],
    ['b04', 'aging', 'a03', 'WINE', 13.8, null, 3860, 75, 'Borgoña 750 ml', day(2026, 9, 20), false, 3, 'cvj_enologa'],
  ]
  const bottlings: BottlingBatchResponse[] = []
  for (const [key, src, skey, ptype, abv, water, bottles, cl, btype, bdate, anchored, seq, rel] of BOTTLING) {
    const s = src === 'aging' ? AG[skey]! : PR[skey]!
    const lot = `${WINERY_CODES[wineryKeyOf(s.wineryId)]}-${dayParts(bdate).year}-${ptype}-${String(seq).padStart(3, '0')}`
    bottlings.push({
      id: uid(`bottling:${key}`),
      wineryId: s.wineryId,
      wineAgingBatchId: src === 'aging' ? s.id : null,
      productionBatchId: src === 'production' ? s.id : null,
      productType: ptype,
      internationalLotCode: lot,
      finalAlcoholAbv: abv,
      waterDilutionLiters: water,
      totalBottlesPackaged: bottles,
      packagingFormatCl: cl,
      bottleType: btype,
      labelDesignUrl: `/mocks/uploads/labels/${lot.toLowerCase()}.png`,
      bottlingDate: isoAt(bdate, 0),
      releasedByMemberId: uid(`member:${rel}`),
      blockchainAnchorTxHash: anchored ? txhash(`anchor:${key}`) : null,
      blockchainDataHash: txhash(`data:${key}`),
      isAnchoredOnChain: anchored,
      anchoredAt: anchored ? isoAt(addDays(bdate, 1), 12) : null,
      qrBatchUrl: `https://app.drinksonchain.bo/b/${lot}`,
      createdAt: isoAt(bdate, 16),
    })
  }
  const BT: Record<string, BottlingBatchResponse> = {}
  for (const [key] of BOTTLING) BT[key] = bottlings.find((b) => b.id === uid(`bottling:${key}`))!

  // -------------------------------------------------------------------------
  // 9. Laboratorio (BatchLabAnalysisResponseDto)
  // -------------------------------------------------------------------------
  type LabRow = [string, string, number, number, number, number | null, number | null, number | null, number | null, number | null, string]
  const LAB: LabRow[] = [
    ['l01', 'b01', 40.05, 4.8, 0.22, null, null, null, 48.0, 0.02, 'cvj_enologa'],
    ['l02', 'b02', 39.9, 4.6, 0.25, null, null, null, 52.0, 0.03, 'cvj_enologa'],
    ['l03', 'b03', 14.22, 5.6, 0.45, 32.0, 85.0, 1.8, null, null, 'altos_enologa'],
  ]
  const labs: BatchLabAnalysisResponse[] = []
  for (const [key, bkey, abv, tac, vac, fso2, tso2, rs, meth, cu, rev] of LAB) {
    const b = BT[bkey]!
    const bdate = dayFromIso(b.bottlingDate)
    const isWine = b.productType === 'WINE'
    labs.push({
      id: uid(`lab:${key}`),
      bottlingBatchId: b.id,
      certifiedLaboratoryName: 'Laboratorio de Servicios Analíticos ISO 17025',
      accreditedLabCertificationCode: `LAB-SENASAG-2026-${String(880 + Number(key.slice(1))).padStart(3, '0')}`,
      analysisRequestDate: isoAt(addDays(bdate, 1), 0),
      testPerformedAt: isoAt(addDays(bdate, 3), 0),
      actualAlcoholAbv: abv,
      totalAlcoholAbv: abv,
      totalAcidityTartaricGl: tac,
      volatileAcidityAceticGl: vac,
      freeSulfurDioxideMgL: fso2,
      totalSulfurDioxideMgL: tso2,
      reducingSugarsGl: rs,
      totalDryExtractGl: isWine ? 18.5 : null,
      sugarFreeDryExtractGl: isWine ? 17.3 : null,
      overpressureBar: 0,
      methanolContentMgL: meth,
      copperContentMgL: cu,
      additionalParams: b.productType === 'SINGANI' ? { leadMgL: 0, aldehydesMgL: 12.5 } : null,
      laboratoryReportPdfUrl: `/mocks/uploads/lab-reports/${b.internationalLotCode.toLowerCase()}.pdf`,
      conformsToSenasagStandards: true,
      conformsToEuStandards: true,
      conformsToUsaStandards: b.productType === 'SINGANI',
      reviewedByMemberId: uid(`member:${rev}`),
      createdAt: isoAt(addDays(bdate, 3), 15),
    })
  }

  // -------------------------------------------------------------------------
  // 10. Trazabilidad pública y 11. vista derivada LotView
  // -------------------------------------------------------------------------
  const chain = { wineries, terroirs, harvestBatches: harvests, tanks, wineAgings: agings, productionBatches: productions, bottlings, labAnalyses: labs }
  const publicPassports: Record<string, PublicPassport> = {}
  for (const b of bottlings) publicPassports[b.internationalLotCode] = buildPublicPassport(b, chain)

  const lots = deriveLotViews(chain, { today: REFERENCE_DAY })

  return {
    'wineries.json': wineries,
    'users.json': users,
    'wallets.json': wallets,
    'auth-login.json': auth,
    'terroirs.json': terroirs,
    'harvest-batches.json': harvests,
    'fermentation-tanks.json': tanks,
    'fermentation-logs.json': logs,
    'enological-treatments.json': treatments,
    'wine-aging.json': agings,
    'production-batches.json': productions,
    'production-rest-status.json': restStatuses,
    'bottling.json': bottlings,
    'lab-analyses.json': labs,
    'traceability-public.json': publicPassports,
    'lots-view.json': lots,
  }
}
