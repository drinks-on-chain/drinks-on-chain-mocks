#!/usr/bin/env python3
"""
Generador determinista de datos de prueba del ERP · Drinks on Chain.

Produce los JSON de `docs/mocks/erp/` con las formas EXACTAS de los DTO del
backend (OpenAPI 3.0 del 25-09-2026, `GET /docs-json`). Volver a ejecutarlo da
el mismo resultado: los ids son UUID v5 derivados de claves legibles y el azar
usa una semilla fija. Fecha de referencia: 2026-09-25.

    python generate.py            # escribe los JSON junto a este archivo

Cuando exista el repo `doc-mocks` este script se reescribe en TypeScript; los
JSON resultantes son los mismos.
"""
from __future__ import annotations

import json
import random
import uuid
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

OUT = Path(__file__).parent
NS = uuid.UUID("6b2f4c1e-9c3a-4d5e-8f70-1a2b3c4d5e6f")  # namespace fijo del proyecto
TODAY = date(2026, 9, 25)
rng = random.Random(20260925)


def uid(key: str) -> str:
    return str(uuid.uuid5(NS, key))


def iso(d: date, hour: int = 12, minute: int = 0) -> str:
    return datetime(d.year, d.month, d.day, hour, minute, tzinfo=timezone.utc).isoformat().replace("+00:00", "Z")


def day(d: date) -> str:
    return d.isoformat()


def gkey(seed: str) -> str:
    """Dirección Stellar de prueba (56 caracteres, empieza por G). No es una clave real."""
    r = random.Random(seed)
    alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"
    return "G" + "".join(r.choice(alphabet) for _ in range(55))


def txhash(seed: str) -> str:
    r = random.Random(seed)
    return "".join(r.choice("0123456789abcdef") for _ in range(64))


def dump(name: str, data) -> None:
    (OUT / name).write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"  {name:32s} {len(data) if isinstance(data, list) else 'obj'}")


# ---------------------------------------------------------------------------
# 1. Bodegas (WineryResponseDto)
# ---------------------------------------------------------------------------
WINERIES = [
    dict(key="altos", code="ALT", legalName="Altos de Calamuchita S.R.L.", commercialName="Bodega Altos de Calamuchita",
         beverageCategory="WINERY", taxIdNit="1023456019", senasagSanitaryReg="08-01-03-01-0142",
         geographicRegion="Valle Central de Tarija · Santa Ana", address="Camino a Calamuchita km 9, Santa Ana la Nueva, Tarija",
         contactEmail="contacto@altos.test", contactPhone="+59146650142", certificationStatus="ACTIVE",
         approvedAt=date(2026, 3, 2), createdAt=date(2026, 2, 20)),
    dict(key="cintiviejo", code="CVJ", legalName="Destilería Cinti Viejo S.A.", commercialName="Destilería Cinti Viejo",
         beverageCategory="DISTILLERY", taxIdNit="2087654031", senasagSanitaryReg="01-02-01-03-0077",
         geographicRegion="Valle de Cinti · Camargo", address="Av. del Singani 45, Camargo, Chuquisaca",
         contactEmail="contacto@cintiviejo.test", contactPhone="+59146930077", certificationStatus="ACTIVE",
         approvedAt=date(2026, 1, 15), createdAt=date(2026, 1, 8)),
    dict(key="guadalquivir", code="VGQ", legalName="Viñedos del Guadalquivir S.R.L.", commercialName="Viñedos del Guadalquivir",
         beverageCategory="WINERY", taxIdNit="3011223344", senasagSanitaryReg=None,
         geographicRegion="Valle Central de Tarija · Concepción", address=None,
         contactEmail="hola@guadalquivir.test", contactPhone="+59171223344", certificationStatus="PENDING",
         approvedAt=None, createdAt=date(2026, 9, 18)),
    dict(key="uriondo", code="CUR", legalName="Casa Uriondo Ltda.", commercialName="Casa Uriondo",
         beverageCategory="DISTILLERY", taxIdNit="4099887766", senasagSanitaryReg="08-01-03-02-0009",
         geographicRegion="Valle Central de Tarija · Uriondo", address="Plaza principal s/n, Uriondo",
         contactEmail="casa@uriondo.test", contactPhone="+59146660009", certificationStatus="SUSPENDED",
         approvedAt=date(2025, 11, 3), createdAt=date(2025, 10, 20)),
]

wineries = []
for w in WINERIES:
    wid = uid(f"winery:{w['key']}")
    active = w["certificationStatus"] in ("ACTIVE", "SUSPENDED")
    wineries.append({
        "id": wid,
        "legalName": w["legalName"],
        "commercialName": w["commercialName"],
        "beverageCategory": w["beverageCategory"],
        "taxIdNit": w["taxIdNit"],
        "senasagSanitaryReg": w["senasagSanitaryReg"],
        "geographicRegion": w["geographicRegion"],
        "countryCode": "BO",
        "address": w["address"],
        "contactEmail": w["contactEmail"],
        "contactPhone": w["contactPhone"],
        "logoUrl": f"/mocks/uploads/logos/{w['key']}.png",
        "stellarPublicKey": gkey(f"winery-wallet:{w['key']}") if active else None,
        "onchainProducerId": f"PROD_BO_{w['taxIdNit']}" if active else None,
        "onchainRegisterTxHash": txhash(f"register:{w['key']}") if active else None,
        "isExportCertified": w["key"] == "cintiviejo",
        "certificationStatus": w["certificationStatus"],
        "approvedAt": iso(w["approvedAt"], 10) if w["approvedAt"] else None,
        "createdAt": iso(w["createdAt"], 9),
        "members": [],  # se rellena abajo
    })
W = {w["key"]: next(x for x in wineries if x["id"] == uid(f"winery:{w['key']}")) for w in WINERIES}
WCODE = {w["key"]: w["code"] for w in WINERIES}

# ---------------------------------------------------------------------------
# 2. Usuarios (UserProfileResponseDto) y billeteras (WalletResponseDto)
# ---------------------------------------------------------------------------
PEOPLE = [
    # key, email, fullName, userRole, wineryKey, memberRole, license, phone
    ("admin", "gestor@drinksonchain.test", "Ana Gutiérrez", "PLATFORM_ADMIN", None, None, None, "+59170000001"),
    ("soporte", "soporte@drinksonchain.test", "Pablo Rivera", "PLATFORM_ADMIN", None, None, None, "+59170000002"),
    ("altos_admin", "admin@altos.test", "Martín Calamuchita", "WINERY_ADMIN", "altos", "OWNER", None, "+59171000101"),
    ("altos_enologa", "enologa@altos.test", "Lic. Carla Villarroel", "ENOLOGIST", "altos", "ENOLOGIST", "COL-ENOL-TAR-118", "+59171000102"),
    ("altos_agronomo", "agronomo@altos.test", "Ing. Diego Paredes", "AGRONOMIST", "altos", "AGRONOMIST", "CIA-TAR-522", "+59171000103"),
    ("altos_operario", "operario@altos.test", "Mario Quispe", "ENOLOGIST", "altos", "OPERATOR", None, "+59171000104"),
    ("cvj_admin", "admin@cintiviejo.test", "Rosa Camargo", "WINERY_ADMIN", "cintiviejo", "OWNER", None, "+59172000201"),
    ("cvj_enologa", "enologa@cintiviejo.test", "Lic. Lucía Rojas", "ENOLOGIST", "cintiviejo", "ENOLOGIST", "COL-ENOL-CHQ-041", "+59172000202"),
    ("cvj_agronomo", "agronomo@cintiviejo.test", "Ing. Tomás Flores", "AGRONOMIST", "cintiviejo", "AGRONOMIST", "CIA-CHQ-207", "+59172000203"),
    ("cvj_operario", "operario@cintiviejo.test", "Rubén Flores", "ENOLOGIST", "cintiviejo", "OPERATOR", None, "+59172000204"),
    ("vgq_admin", "gerencia@guadalquivir.test", "Elena Vaca", "WINERY_ADMIN", "guadalquivir", "OWNER", None, "+59173000301"),
    ("maria", "maria@tribu.test", "María Fernández", "CONSUMER", None, None, None, "+59174000401"),
    ("carlos", "carlos@tribu.test", "Carlos Mamani", "CONSUMER", None, None, None, "+59174000402"),
    ("juan_pos", "cajero.lacava@drinksonchain.test", "Juan Pérez", "POS_OPERATOR", None, None, None, "+59175000501"),
]

users, wallets = [], []
for key, email, name, role, wkey, mrole, lic, phone in PEOPLE:
    uid_ = uid(f"user:{key}")
    created = date(2026, 1, 10) + timedelta(days=rng.randint(0, 200))
    wallet = {
        "id": uid(f"wallet:{key}"),
        "userId": uid_,
        "wineryId": W[wkey]["id"] if wkey else None,
        "stellarPublicAddress": gkey(f"user-wallet:{key}"),
        "walletType": "CUSTODIAL",
        "walletPurpose": "PRODUCER_SIGNING" if wkey else "CONSUMER_NFT",
        "isPrimary": True,
        "createdAt": iso(created, 9, 5),
    }
    wallets.append(wallet)
    memberships = []
    if wkey:
        joined = created + timedelta(days=1)
        memberships.append({
            "wineryId": W[wkey]["id"],
            "wineryName": W[wkey]["commercialName"],
            "memberRole": mrole,
            "professionalLicenseNumber": lic,
            "isActive": True,
            "joinedAt": iso(joined, 10),
        })
        W[wkey]["members"].append({
            "id": uid(f"member:{key}"),
            "userId": uid_,
            "fullName": name,
            "email": email,
            "memberRole": mrole,
            "professionalLicenseNumber": lic,
            "isActive": True,
            "joinedAt": iso(joined, 10),
        })
    users.append({
        "id": uid_,
        "email": email,
        "fullName": name,
        "userRole": role,
        "phoneNumber": phone,
        "preferredLocale": "es",
        "isActive": True,
        "lastLoginAt": iso(TODAY - timedelta(days=rng.randint(0, 6)), 8, 30),
        "createdAt": iso(created, 9),
        "wineryMemberships": memberships,
        "primaryWallet": wallet,
        # Solo para los mocks: credencial de demo y clave legible.
        "_mock": {"key": key, "password": "demo1234"},
    })
U = {u["_mock"]["key"]: u for u in users}


def auth_response(key: str) -> dict:
    u = U[key]
    m = u["wineryMemberships"][0] if u["wineryMemberships"] else None
    return {
        "user": {
            "id": u["id"], "email": u["email"], "fullName": u["fullName"], "userRole": u["userRole"],
            "phoneNumber": u["phoneNumber"], "preferredLocale": "es",
            "wineryId": m["wineryId"] if m else None, "memberRole": m["memberRole"] if m else None,
        },
        "tokens": {
            "accessToken": f"mock.access.{key}", "refreshToken": f"mock.refresh.{key}",
            "tokenType": "Bearer", "expiresIn": 604800,
        },
    }


auth = {u["_mock"]["key"]: auth_response(u["_mock"]["key"]) for u in users}

# ---------------------------------------------------------------------------
# 3. Terroirs (TerroirResponseDto)
# ---------------------------------------------------------------------------
TERROIRS = [
    # key, winery, parcelName, cadastre, ha, masl, lat, lon, variety, soil, doEligible, doType
    ("altos_01", "altos", "Cuartel 1 · La Angostura", "CAT-TAR-1101", 6.8, 1860, -21.5610, -64.6880, "Tannat", "Franco-arcilloso con cantos rodados", True, "Valles Altos de Bolivia"),
    ("altos_02", "altos", "Cuartel 2 · Los Sauces", "CAT-TAR-1102", 4.1, 1875, -21.5590, -64.6910, "Moscatel de Alejandría", "Franco-arenoso", True, "D.O. Singani"),
    ("altos_03", "altos", "Cuartel 3 · El Portillo", "CAT-TAR-1103", 2.1, 1540, -21.5720, -64.6700, "Moscatel de Alejandría", "Arcilloso profundo", False, None),
    ("altos_04", "altos", "Cuartel 4 · Loma Alta", "CAT-TAR-1104", 3.6, 1910, -21.5550, -64.6950, "Syrah", "Franco con grava", True, "Valles Altos de Bolivia"),
    ("altos_05", "altos", "Cuartel 5 · La Compañía", "CAT-TAR-1105", 5.0, 1890, -21.5580, -64.6890, "Cabernet Sauvignon", "Franco-arcilloso", True, "Valles Altos de Bolivia"),
    ("cvj_01", "cintiviejo", "Parcela 1 · Los Parrales", "CAT-CIN-2201", 4.2, 2350, -20.6480, -65.2250, "Moscatel de Alejandría", "Franco-arenoso con grava fluvial", True, "D.O. Singani"),
    ("cvj_02", "cintiviejo", "Parcela 2 · Cañón Viejo", "CAT-CIN-2202", 3.3, 2410, -20.6520, -65.2310, "Moscatel de Alejandría", "Aluvial calcáreo", True, "D.O. Singani"),
    ("cvj_03", "cintiviejo", "Parcela 3 · Las Carreras", "CAT-CIN-2203", 2.7, 2280, -20.6600, -65.2180, "Vischoqueña", "Franco-arenoso", True, "Valles Altos de Bolivia"),
    ("cvj_04", "cintiviejo", "Parcela 4 · El Molino", "CAT-CIN-2204", 1.9, 2320, -20.6550, -65.2200, "Moscatel de Alejandría", "Pedregoso", True, "D.O. Singani"),
    ("cvj_05", "cintiviejo", "Parcela 5 · San Roque", "CAT-CIN-2205", 3.8, 2390, -20.6440, -65.2290, "Negra Criolla", "Franco", True, "Valles Altos de Bolivia"),
    ("vgq_01", "guadalquivir", "Finca El Rancho · lote A", "CAT-TAR-3301", 7.2, 1790, -21.4300, -64.7900, "Syrah", "Franco-arcilloso", True, "Valles Altos de Bolivia"),
]
terroirs = []
for i, (key, wkey, name, cad, ha, masl, lat, lon, variety, soil, do_ok, do_type) in enumerate(TERROIRS):
    terroirs.append({
        "id": uid(f"terroir:{key}"),
        "wineryId": W[wkey]["id"],
        "parcelName": name,
        "cadastreCode": cad,
        "surfaceHectares": ha,
        "altitudeMasl": masl,
        "latitude": lat,
        "longitude": lon,
        "geographicPolygonGeojson": {
            "type": "Polygon",
            "coordinates": [[[lon - 0.002, lat - 0.0015], [lon + 0.002, lat - 0.0015], [lon + 0.002, lat + 0.0015], [lon - 0.002, lat + 0.0015], [lon - 0.002, lat - 0.0015]]],
        },
        "rawMaterialType": "uva",
        "varietyName": variety,
        "soilType": soil,
        "irrigationSystem": rng.choice(["Riego por goteo", "Secano", "Riego por surcos"]),
        "isDoEligible": do_ok,
        "doType": do_type,
        "doCertificateUrl": f"/mocks/uploads/certificates/do-{key}.pdf" if do_ok else None,
        "isActive": key != "altos_03" or True,
        "createdAt": iso(date(2026, 1, 20) + timedelta(days=i * 3), 11),
    })
T = {t["parcelName"]: t for t in terroirs}
TK = {key: next(t for t in terroirs if t["id"] == uid(f"terroir:{key}")) for key, *_ in TERROIRS}

# ---------------------------------------------------------------------------
# 4. Lotes de vendimia (HarvestBatchResponseDto)
# ---------------------------------------------------------------------------
# key, terroir, intake, gross, tare, brix, ph, acidity, temp, status, certifiedBy
HARVESTS = [
    ("h01", "cvj_01", date(2026, 3, 4), 18550, 150, 23.4, 3.40, 5.9, 15.8, "APPROVED", "cvj_enologa"),      # → SGR 2026 (reposo)
    ("h02", "cvj_02", date(2025, 3, 10), 15000, 150, 22.4, 3.45, 6.8, 16.5, "APPROVED", "cvj_enologa"),    # → Singani listo (embotellado 2026)
    ("h03", "cvj_04", date(2025, 3, 18), 9100, 100, 22.9, 3.38, 6.4, 17.0, "APPROVED", "cvj_enologa"),     # → Singani clásico (embotellado)
    ("h04", "cvj_03", date(2025, 2, 26), 7300, 100, 24.1, 3.55, 5.7, 14.2, "APPROVED", "cvj_enologa"),     # → Vino patrimonial (crianza READY)
    ("h05", "cvj_05", date(2026, 3, 12), 6400, 100, 23.0, 3.50, 6.0, 15.0, "PENDING_INSPECTION", None),    # ingreso pendiente de análisis
    ("h06", "altos_01", date(2025, 3, 2), 8500, 100, 24.5, 3.60, 5.8, 14.0, "APPROVED", "altos_enologa"),  # → Tannat Reserva 2024 (crianza AGING, 38 d)
    ("h07", "altos_02", date(2026, 3, 9), 12200, 150, 22.8, 3.42, 6.5, 16.1, "APPROVED", "altos_enologa"), # → Moscatel Blanco (fermentando)
    ("h08", "altos_04", date(2025, 3, 20), 7800, 100, 25.1, 3.65, 5.5, 13.5, "APPROVED", "altos_enologa"), # → Syrah 2024 (crianza AGING, 156 d)
    ("h09", "altos_05", date(2025, 3, 6), 9900, 100, 24.8, 3.62, 5.6, 14.4, "APPROVED", "altos_enologa"),  # → Blend de altura 2023 (embotellado)
    ("h10", "altos_03", date(2026, 3, 15), 4100, 50, 21.2, 3.70, 5.0, 18.0, "REJECTED", "altos_enologa"),  # rechazado (Brix bajo)
    ("h11", "altos_01", date(2026, 3, 22), 6200, 100, 23.9, 3.58, 5.9, 15.2, "QUARANTINE", "altos_agronomo"),
    ("h12", "altos_02", date(2026, 9, 24), 6200, 100, 0.0, 0.0, 0.0, 16.0, "PENDING_INSPECTION", None),     # pesaje de hoy, sin laboratorio
]
harvests = []
for key, tkey, intake, gross, tare, brix, ph, acid, temp, status, cert in HARVESTS:
    t = TK[tkey]
    wkey = next(k for k, w in W.items() if w["id"] == t["wineryId"])
    slug = t["parcelName"].split("·")[-1].strip().split()[-1].upper()
    harvests.append({
        "id": uid(f"harvest:{key}"),
        "wineryId": t["wineryId"],
        "terroirId": t["id"],
        "harvestBatchCode": f"HARV-{intake.year}-{slug}-{key[-2:]}",
        "intakeDate": iso(intake, 9, 42),
        "harvestYear": intake.year,
        "grossWeightKg": gross,
        "tareWeightKg": tare,
        "netWeightKg": gross - tare,
        "brixDegrees": brix,
        "initialPh": ph,
        "initialAcidityGl": acid,
        "temperatureAtIntakeC": temp,
        "phytosanitaryStatus": status,
        "phytoInspectionPdfUrl": f"/mocks/uploads/inspections/phyto-{key}.pdf" if status in ("APPROVED", "REJECTED", "QUARANTINE") else None,
        "certifiedByMemberId": uid(f"member:{cert}") if cert else None,
        "notes": rng.choice(["Cosecha manual matutina en cajas de 15 kg.", "Uva sana, sin botritis.", "Ingreso por camión, tara verificada en báscula.", None]),
        "createdAt": iso(intake, 9, 45),
    })
H = {key: next(h for h in harvests if h["id"] == uid(f"harvest:{key}")) for key, *_ in HARVESTS}

# ---------------------------------------------------------------------------
# 5. Tanques de fermentación (FermentationTankResponseDto) + logs + tratamientos
# ---------------------------------------------------------------------------
# key, harvest, tankCode, capacity, filled, destination, status, start, end
TANKS = [
    ("t01", "h01", "TK-03", 15000, 12100, "SINGANI_DIST", "TRANSFERRED", date(2026, 3, 6), date(2026, 4, 14)),
    ("t02", "h02", "TK-01", 15000, 10100, "SINGANI_DIST", "TRANSFERRED", date(2025, 3, 11), date(2025, 4, 12)),
    ("t03", "h03", "TK-02", 10000, 6100, "SINGANI_DIST", "TRANSFERRED", date(2025, 3, 19), date(2025, 4, 20)),
    ("t04", "h04", "TK-05", 8000, 4900, "WINE_AGING", "TRANSFERRED", date(2025, 2, 27), date(2025, 3, 20)),
    ("t05", "h07", "TK-04", 10000, 8300, "WINE_AGING", "FERMENTING", date(2026, 3, 10), None),          # temperatura alta hoy
    ("t06", "h06", "TK-RED-01", 10000, 5800, "WINE_AGING", "TRANSFERRED", date(2025, 3, 3), date(2025, 3, 24)),
    ("t07", "h08", "TK-RED-02", 10000, 5300, "WINE_AGING", "TRANSFERRED", date(2025, 3, 21), date(2025, 4, 11)),
    ("t08", "h09", "TK-RED-03", 12000, 6700, "WINE_AGING", "TRANSFERRED", date(2025, 3, 7), date(2025, 3, 28)),
    ("t09", "h07", "TK-06", 10000, 0, "WINE_AGING", "CLEANED", date(2026, 1, 5), date(2026, 1, 6)),
    ("t10", "h11", "TK-07", 8000, 4200, "OTHER", "FILLING", date(2026, 9, 24), None),
    ("t11", "h01", "TK-08", 8000, 6300, "SINGANI_DIST", "COMPLETED", date(2026, 3, 7), date(2026, 4, 2)),   # listo para bifurcar/destilar
    ("t12", "h02", "TK-09", 15000, 0, "SINGANI_DIST", "CLEANED", date(2025, 3, 11), date(2025, 4, 13)),
    ("t13", "h06", "TK-RED-04", 10000, 0, "WINE_AGING", "CLEANED", date(2025, 3, 3), date(2025, 3, 25)),
    ("t14", "h07", "TK-10", 5000, 3900, "WINE_AGING", "FERMENTING", date(2026, 3, 11), None),
]
tanks, logs, treatments = [], [], []
for key, hkey, code, cap, filled, dest, status, start, end in TANKS:
    h = H[hkey]
    tid = uid(f"tank:{key}")
    tanks.append({
        "id": tid,
        "wineryId": h["wineryId"],
        "harvestBatchId": h["id"],
        "tankCode": code,
        "capacityLiters": cap,
        "material": "Acero inoxidable AISI 316",
        "volumeFilledLiters": filled,
        "destinationType": dest,
        "status": status,
        "startDate": iso(start, 14, 30),
        "endDate": iso(end, 14, 30) if end else None,
        "createdAt": iso(start, 14, 35),
    })
    if status in ("FERMENTING", "COMPLETED", "TRANSFERRED"):
        last = end or TODAY
        n_days = min((last - start).days, 24)
        sg = 1.092
        for d in range(n_days):
            when = start + timedelta(days=d + 1)
            sg = max(0.992, sg - rng.uniform(0.003, 0.006))
            temp = 22.0 + rng.uniform(-1.5, 1.5)
            if key == "t05" and d >= n_days - 3:
                temp = 27.0 + rng.uniform(0, 0.8)  # alerta de temperatura
            logs.append({
                "id": uid(f"log:{key}:{d}"),
                "fermentationTankId": tid,
                "temperatureCelsius": round(temp, 1),
                "specificGravity": round(sg, 3),
                "phValue": round(3.4 + rng.uniform(-0.05, 0.08), 2),
                "co2Observations": rng.choice(["Desprendimiento vigoroso de CO2", "Fermentación regular", "Sombrero bien hidratado", None]),
                "recordedAt": iso(when, 8),
                "notes": rng.choice(["Remontado matutino de 20 min", None, None]),
                "recordedByMemberId": uid("member:" + ("altos_operario" if h["wineryId"] == W["altos"]["id"] else "cvj_operario")),
            })
        treatments.append({
            "id": uid(f"treatment:{key}:so2"),
            "fermentationTankId": tid,
            "treatmentType": "SO2_ADDITION",
            "additiveName": "Metabisulfito de potasio grado alimentario",
            "additiveSupplier": "Laffort Oenologie",
            "dosageAppliedGPerHl": 30.0,
            "totalAppliedG": round(30.0 * filled / 100, 1) if filled else None,
            "regulatoryAuthCode": "SENASAG-REG-ADD-2024-88",
            "appliedAt": iso(start, 15),
            "notes": "Sulfitado inicial",
        })
        if dest == "WINE_AGING":
            treatments.append({
                "id": uid(f"treatment:{key}:nut"),
                "fermentationTankId": tid,
                "treatmentType": "NUTRIENT_ADDITION",
                "additiveName": "Fosfato diamónico y levadura Saccharomyces cerevisiae seleccionada",
                "additiveSupplier": "Enartis",
                "dosageAppliedGPerHl": 20.0,
                "totalAppliedG": round(20.0 * filled / 100, 1) if filled else None,
                "regulatoryAuthCode": "SENASAG-REG-ADD-2024-112",
                "appliedAt": iso(start + timedelta(days=1), 12),
                "notes": "Adición al primer tercio de fermentación",
            })
TN = {key: next(t for t in tanks if t["id"] == uid(f"tank:{key}")) for key, *_ in TANKS}

# ---------------------------------------------------------------------------
# 6. Crianza (WineAgingResponseDto)
# ---------------------------------------------------------------------------
# key, tank, containerMaterial, code, cycle, liters, months, start, status
AGING = [
    ("a01", "t06", "Roble francés grano fino (Allier), tostado medio", "BAR-FR-2024-01", 1, 3375, 12, date(2025, 11, 3), "AGING"),     # 38 d restantes
    ("a02", "t07", "Roble americano, tostado medio plus", "BAR-US-2024-07", 2, 3150, 8, date(2026, 6, 30), "AGING"),                 # 156 d restantes
    ("a03", "t04", "Roble francés, tostado ligero", "BAR-FR-2023-11", 3, 2925, 10, date(2025, 4, 1), "READY"),                        # liberado
    ("a04", "t08", "Roble francés (Nevers), tostado medio", "BAR-FR-2023-04", 1, 4050, 12, date(2025, 4, 10), "BOTTLED"),            # embotellado
]
agings = []
for key, tkey, mat, code, cycle, liters, months, start, status in AGING:
    t = TN[tkey]
    lock = date(start.year + (start.month - 1 + months) // 12, (start.month - 1 + months) % 12 + 1, min(start.day, 28))
    agings.append({
        "id": uid(f"aging:{key}"),
        "wineryId": t["wineryId"],
        "fermentationTankId": t["id"],
        "containerType": "Barrica",
        "containerMaterial": mat,
        "containerCode": code,
        "barrelUseCycle": cycle,
        "volumeLiters": liters,
        "plannedMonths": months,
        "lockUntilDate": iso(lock, 0),
        "agingStatus": status,
        "notes": "Cava subterránea a 14 °C y 75 % HR",
        "createdAt": iso(start, 10),
    })
AG = {key: next(a for a in agings if a["id"] == uid(f"aging:{key}")) for key, *_ in AGING}

# ---------------------------------------------------------------------------
# 7. Destilación (ProductionBatchResponseDto)
# ---------------------------------------------------------------------------
# key, tank, equipment, start, end, in, out, waste, abv, status
DIST = [
    ("p01", "t01", "Alambique de cobre Charentais AL-01", date(2026, 4, 15), date(2026, 4, 16), 12100, 1500, 330, 60.0, "RESTING"),   # SGR 2026 · 142 d
    ("p02", "t02", "Alambique de cobre Charentais AL-01", date(2025, 5, 20), date(2025, 5, 25), 10000, 1750, 570, 70.2, "BOTTLED"),   # Singani aniversario
    ("p03", "t03", "Alambique de cobre AL-02", date(2025, 5, 2), date(2025, 5, 4), 6100, 980, 290, 65.4, "BOTTLED"),                  # Clásico 2025
    ("p04", "t11", "Alambique de cobre AL-02", date(2026, 9, 10), date(2026, 9, 12), 6300, 900, 260, 62.1, "RESTING"),                # recién destilado · 168 d
    ("p05", "t03", "Alambique de cobre AL-02", date(2026, 3, 20), date(2026, 3, 22), 3000, 450, 120, 64.0, "READY"),                  # reposo cumplido
]
productions = []
for key, tkey, equip, start, end, vin, vout, waste, abv, status in DIST:
    t = TN[tkey]
    rest_until = end + timedelta(days=180)
    productions.append({
        "id": uid(f"production:{key}"),
        "wineryId": t["wineryId"],
        "fermentationTankId": t["id"],
        "processType": "SINGANI_DISTILLATION",
        "equipmentIdentifier": equip,
        "processStartDate": iso(start, 0),
        "processEndDate": iso(end, 0),
        "inputVolumeLiters": vin,
        "outputVolumeLiters": vout,
        "wasteVolumeLiters": waste,
        "initialAlcoholPercentage": abv,
        "isDoEligible": True,
        "mandatoryRestUntil": iso(rest_until, 0),
        "restStatus": status,
        "additionalParams": {"headDiscardLiters": round(waste * 0.3), "heartYieldLiters": vout, "tailDiscardLiters": round(waste * 0.7)},
        "notes": "Destilación lenta a fuego directo con separación estricta de cabezas",
        "createdAt": iso(start, 10),
    })
PR = {key: next(p for p in productions if p["id"] == uid(f"production:{key}")) for key, *_ in DIST}


def rest_status(p: dict) -> dict:
    end = date.fromisoformat(p["processEndDate"][:10])
    elapsed = (TODAY - end).days
    remaining = max(0, 180 - elapsed)
    return {"id": p["id"], "restStatus": p["restStatus"], "daysElapsed": elapsed, "daysRemaining": remaining,
            "isRestCompleted": remaining == 0, "mandatoryRestUntil": p["mandatoryRestUntil"]}


rest_statuses = [rest_status(p) for p in productions]

# ---------------------------------------------------------------------------
# 8. Embotellado (BottlingBatchResponseDto)
# ---------------------------------------------------------------------------
# key, source ('aging'|'production'), srcKey, productType, abv, water, bottles, cl, bottleType, date, anchored, seq, releasedBy
BOTTLING = [
    ("b01", "production", "p02", "SINGANI", 40.0, 1321, 4080, 75, "Vidrio extra-flint 750 ml", date(2026, 3, 1), True, 1, "cvj_enologa"),
    ("b02", "production", "p03", "SINGANI", 40.0, 620, 2140, 75, "Vidrio flint 750 ml", date(2026, 2, 10), True, 2, "cvj_enologa"),
    ("b03", "aging", "a04", "WINE", 14.2, None, 5320, 75, "Bordelesa cónica verde antiguo 750 ml", date(2026, 5, 12), True, 1, "altos_enologa"),
    ("b04", "aging", "a03", "WINE", 13.8, None, 3860, 75, "Borgoña 750 ml", date(2026, 9, 20), False, 3, "cvj_enologa"),   # recién embotellado, sin anclar
]
bottlings = []
for key, src, skey, ptype, abv, water, bottles, cl, btype, bdate, anchored, seq, rel in BOTTLING:
    s = AG[skey] if src == "aging" else PR[skey]
    wkey = next(k for k, w in W.items() if w["id"] == s["wineryId"])
    lot = f"{WCODE[wkey]}-{bdate.year}-{ptype}-{seq:03d}"
    bottlings.append({
        "id": uid(f"bottling:{key}"),
        "wineryId": s["wineryId"],
        "wineAgingBatchId": s["id"] if src == "aging" else None,
        "productionBatchId": s["id"] if src == "production" else None,
        "productType": ptype,
        "internationalLotCode": lot,
        "finalAlcoholAbv": abv,
        "waterDilutionLiters": water,
        "totalBottlesPackaged": bottles,
        "packagingFormatCl": cl,
        "bottleType": btype,
        "labelDesignUrl": f"/mocks/uploads/labels/{lot.lower()}.png",
        "bottlingDate": iso(bdate, 0),
        "releasedByMemberId": uid(f"member:{rel}"),
        "blockchainAnchorTxHash": txhash(f"anchor:{key}") if anchored else None,
        "blockchainDataHash": txhash(f"data:{key}"),
        "isAnchoredOnChain": anchored,
        "anchoredAt": iso(bdate + timedelta(days=1), 12) if anchored else None,
        "qrBatchUrl": f"https://app.drinksonchain.bo/b/{lot}",
        "createdAt": iso(bdate, 16),
    })
BT = {key: next(b for b in bottlings if b["id"] == uid(f"bottling:{key}")) for key, *_ in BOTTLING}

# ---------------------------------------------------------------------------
# 9. Laboratorio (BatchLabAnalysisResponseDto)
# ---------------------------------------------------------------------------
LAB = [
    ("l01", "b01", 40.05, 4.8, 0.22, None, None, None, 48.0, 0.02, "cvj_enologa"),
    ("l02", "b02", 39.90, 4.6, 0.25, None, None, None, 52.0, 0.03, "cvj_enologa"),
    ("l03", "b03", 14.22, 5.6, 0.45, 32.0, 85.0, 1.8, None, None, "altos_enologa"),
]
labs = []
for key, bkey, abv, tac, vac, fso2, tso2, rs, meth, cu, rev in LAB:
    b = BT[bkey]
    bdate = date.fromisoformat(b["bottlingDate"][:10])
    labs.append({
        "id": uid(f"lab:{key}"),
        "bottlingBatchId": b["id"],
        "certifiedLaboratoryName": "Laboratorio de Servicios Analíticos ISO 17025",
        "accreditedLabCertificationCode": f"LAB-SENASAG-2026-{880 + int(key[1:]):03d}",
        "analysisRequestDate": iso(bdate + timedelta(days=1), 0),
        "testPerformedAt": iso(bdate + timedelta(days=3), 0),
        "actualAlcoholAbv": abv,
        "totalAlcoholAbv": abv,
        "totalAcidityTartaricGl": tac,
        "volatileAcidityAceticGl": vac,
        "freeSulfurDioxideMgL": fso2,
        "totalSulfurDioxideMgL": tso2,
        "reducingSugarsGl": rs,
        "totalDryExtractGl": 18.5 if b["productType"] == "WINE" else None,
        "sugarFreeDryExtractGl": 17.3 if b["productType"] == "WINE" else None,
        "overpressureBar": 0,
        "methanolContentMgL": meth,
        "copperContentMgL": cu,
        "additionalParams": {"leadMgL": 0, "aldehydesMgL": 12.5} if b["productType"] == "SINGANI" else None,
        "laboratoryReportPdfUrl": f"/mocks/uploads/lab-reports/{b['internationalLotCode'].lower()}.pdf",
        "conformsToSenasagStandards": True,
        "conformsToEuStandards": True,
        "conformsToUsaStandards": b["productType"] == "SINGANI",
        "reviewedByMemberId": uid(f"member:{rev}"),
        "createdAt": iso(bdate + timedelta(days=3), 15),
    })
LB = {l["bottlingBatchId"]: l for l in labs}

# ---------------------------------------------------------------------------
# 10. Trazabilidad pública (GET /v1/traceability/public/:lotCode)
# ---------------------------------------------------------------------------
public = {}
for b in bottlings:
    w = next(x for x in wineries if x["id"] == b["wineryId"])
    if b["productionBatchId"]:
        p = next(x for x in productions if x["id"] == b["productionBatchId"])
        tank = next(x for x in tanks if x["id"] == p["fermentationTankId"])
    else:
        a = next(x for x in agings if x["id"] == b["wineAgingBatchId"])
        tank = next(x for x in tanks if x["id"] == a["fermentationTankId"])
    h = next(x for x in harvests if x["id"] == tank["harvestBatchId"])
    t = next(x for x in terroirs if x["id"] == h["terroirId"])
    lab = LB.get(b["id"])
    public[b["internationalLotCode"]] = {
        "lotCode": b["internationalLotCode"],
        "winery": {"commercialName": w["commercialName"], "department": w["geographicRegion"].split("·")[0].strip(), "altitudeMasl": t["altitudeMasl"]},
        "product": {"productType": b["productType"], "alcoholAbv": b["finalAlcoholAbv"], "bottlesPackaged": b["totalBottlesPackaged"],
                    "packagingFormatCl": b["packagingFormatCl"], "bottlingDate": b["bottlingDate"]},
        "terroir": {"parcelName": t["parcelName"], "altitudeMasl": t["altitudeMasl"], "varietyName": t["varietyName"],
                    "doEligible": t["isDoEligible"], "doType": t["doType"]},
        "laboratoryCertification": ({
            "certifiedLaboratoryName": lab["certifiedLaboratoryName"], "accreditedLabCertificationCode": lab["accreditedLabCertificationCode"],
            "actualAlcoholAbv": lab["actualAlcoholAbv"], "totalAcidityTartaricGl": lab["totalAcidityTartaricGl"],
            "volatileAcidityAceticGl": lab["volatileAcidityAceticGl"], "conformsToSenasagStandards": lab["conformsToSenasagStandards"],
            "reportPdfUrl": lab["laboratoryReportPdfUrl"]} if lab else None),
        "blockchainIntegrity": {"sha256Hash": b["blockchainDataHash"], "network": "Stellar Testnet",
                                "status": "VERIFIED_ON_CHAIN" if b["isAnchoredOnChain"] else "PENDING_ANCHOR"},
    }

# ---------------------------------------------------------------------------
# 11. Vista derivada "Lote" para las pantallas del ERP (no existe en el backend)
# ---------------------------------------------------------------------------
# Une la cadena vendimia → tanque → crianza | destilación → embotellado en una fila por
# lote de vendimia, con el estado que muestra el ERP. Se calcula en el cliente.
def lot_view(h: dict) -> dict:
    t = next(x for x in terroirs if x["id"] == h["terroirId"])
    tks = [x for x in tanks if x["harvestBatchId"] == h["id"] and x["status"] != "CLEANED"]
    ag = [a for a in agings for x in tks if a["fermentationTankId"] == x["id"]]
    pr = [p for p in productions for x in tks if p["fermentationTankId"] == x["id"]]
    bt = [b for b in bottlings if (ag and b["wineAgingBatchId"] in {a["id"] for a in ag}) or (pr and b["productionBatchId"] in {p["id"] for p in pr})]
    if bt:
        stage, lock = "embotellado", None
    elif ag:
        a = ag[0]; stage = "crianza"
        lock = {"kind": "crianza", "unlockAt": a["lockUntilDate"], "released": a["agingStatus"] == "READY"}
    elif pr:
        p = pr[0]; stage = "reposo"
        rs = rest_status(p)
        lock = {"kind": "reposo", "unlockAt": p["mandatoryRestUntil"], "released": rs["isRestCompleted"], "daysRemaining": rs["daysRemaining"]}
    elif tks and any(x["status"] == "COMPLETED" for x in tks):
        stage, lock = "bifurcacion", None
    elif tks:
        stage, lock = "fermentacion", None
    elif h["phytosanitaryStatus"] == "APPROVED":
        stage, lock = "vendimia", None
    elif h["phytosanitaryStatus"] == "REJECTED":
        stage, lock = "rechazado", None
    else:
        stage, lock = "pesaje", None
    kind = "singani" if any(x["destinationType"] == "SINGANI_DIST" for x in tks) or pr else ("vino" if ag or bt else None)
    return {
        "harvestBatchId": h["id"], "harvestBatchCode": h["harvestBatchCode"], "wineryId": h["wineryId"],
        "terroir": {"id": t["id"], "parcelName": t["parcelName"], "varietyName": t["varietyName"], "altitudeMasl": t["altitudeMasl"], "isDoEligible": t["isDoEligible"]},
        "kind": kind, "stage": stage, "phytosanitaryStatus": h["phytosanitaryStatus"], "netWeightKg": h["netWeightKg"],
        "tankIds": [x["id"] for x in tks], "wineAgingBatchId": ag[0]["id"] if ag else None,
        "productionBatchId": pr[0]["id"] if pr else None, "bottlingBatchId": bt[0]["id"] if bt else None,
        "internationalLotCode": bt[0]["internationalLotCode"] if bt else None, "lock": lock,
    }


lots = [lot_view(h) for h in harvests]

# ---------------------------------------------------------------------------
# Escritura
# ---------------------------------------------------------------------------
print("Generando fixtures del ERP en", OUT)
dump("wineries.json", wineries)
dump("users.json", users)
dump("wallets.json", wallets)
dump("auth-login.json", auth)
dump("terroirs.json", terroirs)
dump("harvest-batches.json", harvests)
dump("fermentation-tanks.json", tanks)
dump("fermentation-logs.json", logs)
dump("enological-treatments.json", treatments)
dump("wine-aging.json", agings)
dump("production-batches.json", productions)
dump("production-rest-status.json", rest_statuses)
dump("bottling.json", bottlings)
dump("lab-analyses.json", labs)
dump("traceability-public.json", public)
dump("lots-view.json", lots)
print("Listo.")
