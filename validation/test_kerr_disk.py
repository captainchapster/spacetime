"""
Checks for the rotating black hole and its accretion disk (app/src/physics/metrics/kerr.ts,
app/src/physics/disk.ts).

1. The Cartesian Kerr–Schild metric solves the vacuum Einstein equations (numerically, at
   random points, from symbolic derivatives).
2. The app's Novikov–Thorne flux, computed from Page & Thorne's integral, matches their
   closed-form result for Kerr (Page & Thorne 1974, as written by Agol & Krolik 2000).
"""

import math
import random

import mpmath as mp
import sympy as sp
from scipy.integrate import quad

# ---------------------------------------------------------------- 1. Kerr is Ricci-flat

x, y, z, t = sp.symbols("x y z t", real=True)
X = (t, x, y, z)
M, a = sp.Rational(1), sp.Rational(9, 10)
rho2 = x**2 + y**2 + z**2
b = rho2 - a**2
r = sp.sqrt(b / 2 + sp.sqrt(b**2 / 4 + a**2 * z**2))
f = 2 * M * r**3 / (r**4 + a**2 * z**2)
l = sp.Matrix([1, (r * x + a * y) / (r**2 + a**2), (r * y - a * x) / (r**2 + a**2), z / r])
eta = sp.diag(-1, 1, 1, 1)
g = eta + f * l * l.T
g_inv = eta - f * (eta * l) * (eta * l).T


def test_kerr_schild_inverse_and_vacuum():
    rng = random.Random(3)
    mp.mp.dps = 30
    # Christoffels Γ^m_ab and their derivatives, evaluated numerically (symbolic Ricci is huge).
    dg = [[[sp.diff(g[i, j], X[n]) for j in range(4)] for i in range(4)] for n in range(4)]
    Gam = [
        [[sum(g_inv[m, n] * (dg[i][n][j] + dg[j][n][i] - dg[n][i][j]) for n in range(4)) / 2 for j in range(4)] for i in range(4)]
        for m in range(4)
    ]
    ric_exprs = []
    for i in range(4):
        for j in range(i, 4):
            ric_exprs.append(
                sum(
                    sp.diff(Gam[m][i][j], X[m])
                    - sp.diff(Gam[m][i][m], X[j])
                    + sum(Gam[m][m][n] * Gam[n][i][j] - Gam[m][j][n] * Gam[n][i][m] for n in range(4))
                    for m in range(4)
                )
            )
    ric = sp.lambdify((x, y, z), ric_exprs + list(g * g_inv), "mpmath")
    for _ in range(3):
        p = [rng.uniform(-5, 5), rng.uniform(-5, 5), rng.uniform(-3, 3)]
        vals = ric(*p)
        ricci, ident = vals[: len(ric_exprs)], vals[len(ric_exprs) :]
        assert max(abs(v) for v in ricci) < 1e-15, (p, ricci)
        assert max(abs(v - (1 if k % 5 == 0 else 0)) for k, v in enumerate(ident)) < 1e-15


# ---------------------------------------------------- 2. Novikov–Thorne disk flux


def orbit(r, s):
    sr = math.sqrt(r)
    den = r**0.75 * math.sqrt(r * sr - 3 * sr + 2 * s)
    return (r * sr - 2 * sr + s) / den, (r * r - 2 * s * sr + s * s) / den, 1 / (r * sr + s)


def isco(s):
    z1 = 1 + (1 - s * s) ** (1 / 3) * ((1 + s) ** (1 / 3) + (1 - s) ** (1 / 3))
    z2 = math.sqrt(3 * s * s + z1 * z1)
    return 3 + z2 - math.sqrt((3 - z1) * (3 + z1 + 2 * z2))


def flux_integral(r, s):
    """The app's route: F = −Ω′/(4π r (E − ΩL)²) ∫ (E − ΩL) L′ dr."""
    d = lambda fn, q: (fn(q * (1 + 1e-6)) - fn(q * (1 - 1e-6))) / (2e-6 * q)
    E = lambda q: orbit(q, s)[0]
    L = lambda q: orbit(q, s)[1]
    W = lambda q: orbit(q, s)[2]
    I, _ = quad(lambda q: (E(q) - W(q) * L(q)) * d(L, q), isco(s), r, epsabs=1e-15, epsrel=1e-10, limit=200)
    e, l_, w = orbit(r, s)
    return -d(W, r) / (4 * math.pi * r * (e - w * l_) ** 2) * I


def flux_closed_form(r, s):
    """Page & Thorne's closed form, in x = √r (Agol & Krolik 2000, eq. 4 with no ISCO torque)."""
    xx = math.sqrt(r)
    x0 = math.sqrt(isco(s))
    x1 = 2 * math.cos(math.acos(s) / 3 - math.pi / 3)
    x2 = 2 * math.cos(math.acos(s) / 3 + math.pi / 3)
    x3 = -2 * math.cos(math.acos(s) / 3)
    bracket = (
        xx
        - x0
        - 1.5 * s * math.log(xx / x0)
        - 3 * (x1 - s) ** 2 / (x1 * (x1 - x2) * (x1 - x3)) * math.log((xx - x1) / (x0 - x1))
        - 3 * (x2 - s) ** 2 / (x2 * (x2 - x1) * (x2 - x3)) * math.log((xx - x2) / (x0 - x2))
        - 3 * (x3 - s) ** 2 / (x3 * (x3 - x1) * (x3 - x2)) * math.log((xx - x3) / (x0 - x3))
    )
    return 3 / (8 * math.pi) / (xx**4 * (xx**3 - 3 * xx + 2 * s)) * bracket


def test_disk_flux_matches_page_thorne_closed_form():
    for s in (0.3, 0.7, 0.95):
        for r in (isco(s) * 1.2, 8.0, 20.0, 150.0):
            assert abs(flux_integral(r, s) / flux_closed_form(r, s) - 1) < 1e-6, (s, r)


def test_reference_values_used_by_the_app_tests():
    # The TypeScript disk test (app/test/ship.test.ts) pins these same numbers.
    for r, ref in ((8.0, 3.7860057e-5), (20.0, 6.1211748e-6), (150.0, 2.6400281e-8)):
        assert abs(flux_closed_form(r, 0.5) / ref - 1) < 1e-6
