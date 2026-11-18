#!/usr/bin/env python3
"""EPSG:5179 (Korea 2000 / Unified CS, UTM-K) ↔ WGS84 변환.

도로명주소 좌표제공 API 가 돌려주는 entX/entY 가 이 좌표계다.
외부 라이브러리를 깔지 않으려고 횡단 메르카토르 역산을 직접 넣었다.

  정의: Transverse Mercator, GRS80
        위도원점 38°N, 경도원점 127.5°E, 축척계수 0.9996,
        가산수평 1,000,000m, 가산수직 2,000,000m

GRS80 과 WGS84 는 타원체가 사실상 같아(장반경 동일, 편평률 차 1e-12 수준)
캠퍼스 규모에서 차이는 밀리미터 이하다. 그래서 데이텀 변환은 생략한다.
"""
import math

A = 6378137.0                 # GRS80 장반경
F = 1 / 298.257222101         # GRS80 편평률
K0 = 0.9996
LAT0 = math.radians(38.0)
LON0 = math.radians(127.5)
X0 = 1_000_000.0
Y0 = 2_000_000.0

E2 = F * (2 - F)
EP2 = E2 / (1 - E2)


def _meridian_arc(lat: float) -> float:
    """적도에서 위도 lat 까지의 자오선 호 길이."""
    e2, e4, e6 = E2, E2 * E2, E2 * E2 * E2
    return A * (
        (1 - e2 / 4 - 3 * e4 / 64 - 5 * e6 / 256) * lat
        - (3 * e2 / 8 + 3 * e4 / 32 + 45 * e6 / 1024) * math.sin(2 * lat)
        + (15 * e4 / 256 + 45 * e6 / 1024) * math.sin(4 * lat)
        - (35 * e6 / 3072) * math.sin(6 * lat)
    )


def to_wgs84(x: float, y: float) -> tuple[float, float]:
    """EPSG:5179 (x=동, y=북) → (위도, 경도)."""
    m = (y - Y0) / K0 + _meridian_arc(LAT0)
    mu = m / (A * (1 - E2 / 4 - 3 * E2**2 / 64 - 5 * E2**3 / 256))
    e1 = (1 - math.sqrt(1 - E2)) / (1 + math.sqrt(1 - E2))

    phi1 = (
        mu
        + (3 * e1 / 2 - 27 * e1**3 / 32) * math.sin(2 * mu)
        + (21 * e1**2 / 16 - 55 * e1**4 / 32) * math.sin(4 * mu)
        + (151 * e1**3 / 96) * math.sin(6 * mu)
        + (1097 * e1**4 / 512) * math.sin(8 * mu)
    )

    sin1, cos1, tan1 = math.sin(phi1), math.cos(phi1), math.tan(phi1)
    c1 = EP2 * cos1**2
    t1 = tan1**2
    n1 = A / math.sqrt(1 - E2 * sin1**2)
    r1 = A * (1 - E2) / (1 - E2 * sin1**2) ** 1.5
    d = (x - X0) / (n1 * K0)

    lat = phi1 - (n1 * tan1 / r1) * (
        d**2 / 2
        - (5 + 3 * t1 + 10 * c1 - 4 * c1**2 - 9 * EP2) * d**4 / 24
        + (61 + 90 * t1 + 298 * c1 + 45 * t1**2 - 252 * EP2 - 3 * c1**2) * d**6 / 720
    )
    lon = LON0 + (
        d
        - (1 + 2 * t1 + c1) * d**3 / 6
        + (5 - 2 * c1 + 28 * t1 - 3 * c1**2 + 8 * EP2 + 24 * t1**2) * d**5 / 120
    ) / cos1

    return math.degrees(lat), math.degrees(lon)


def from_wgs84(lat_deg: float, lon_deg: float) -> tuple[float, float]:
    """(위도, 경도) → EPSG:5179 (x=동, y=북). 왕복 검증용."""
    lat, lon = math.radians(lat_deg), math.radians(lon_deg)
    sin_, cos_, tan_ = math.sin(lat), math.cos(lat), math.tan(lat)
    n = A / math.sqrt(1 - E2 * sin_**2)
    t = tan_**2
    c = EP2 * cos_**2
    a_ = (lon - LON0) * cos_
    m = _meridian_arc(lat)

    x = X0 + K0 * n * (
        a_ + (1 - t + c) * a_**3 / 6 + (5 - 18 * t + t**2 + 72 * c - 58 * EP2) * a_**5 / 120
    )
    y = Y0 + K0 * (
        m - _meridian_arc(LAT0)
        + n * tan_ * (
            a_**2 / 2
            + (5 - t + 9 * c + 4 * c**2) * a_**4 / 24
            + (61 - 58 * t + t**2 + 600 * c - 330 * EP2) * a_**6 / 720
        )
    )
    return x, y


if __name__ == "__main__":
    # 왕복 오차가 밀리미터 수준인지 확인한다 (캠퍼스 일대 여러 점)
    import json, pathlib
    pts = [(36.77004, 126.93192), (37.5665, 126.9780), (35.1796, 129.0756), (33.4996, 126.5312)]
    root = pathlib.Path(__file__).resolve().parent.parent
    f = root / "data" / "buildings.json"
    if f.exists():
        pts += [tuple(b["center"]) for b in json.loads(f.read_text(encoding="utf-8"))["buildings"][:4]]

    worst = 0.0
    for lat, lon in pts:
        x, y = from_wgs84(lat, lon)
        la, lo = to_wgs84(x, y)
        err = math.hypot((la - lat) * 111_000, (lo - lon) * 111_000 * math.cos(math.radians(lat)))
        worst = max(worst, err)
        print(f"  {lat:9.5f},{lon:10.5f} → {x:11.2f},{y:12.2f} → 오차 {err*1000:6.3f} mm")
    print(f"\n최대 왕복 오차 {worst*1000:.3f} mm {'✅' if worst < 0.01 else '❌'}")
