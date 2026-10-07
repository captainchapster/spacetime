"""
Symbolic checks on the metric the app integrates (app/src/physics/metrics/schwarzschild.ts).

Ingoing Kerr–Schild form of Schwarzschild, in Cartesian-like coordinates (G = c = 1):
    g_μν = η_μν + (2M/r) l_μ l_ν,   l_μ = (1, x/r, y/r, z/r)

If this is right it must solve Einstein's vacuum equations (Ricci = 0) away from r = 0;
being static, spherically symmetric and asymptotically flat, Birkhoff's theorem then
makes it Schwarzschild.
"""

import random

import sympy as sp

t, x, y, z = X = sp.symbols("t x y z", real=True)
M = sp.Symbol("M", positive=True)
r = sp.sqrt(x**2 + y**2 + z**2)
eta = sp.diag(-1, 1, 1, 1)
l_lower = sp.Matrix([1, x / r, y / r, z / r])
g = eta + (2 * M / r) * l_lower * l_lower.T
# Kerr–Schild metrics have an exact inverse: g^μν = η^μν − (2M/r) l^μ l^ν with l^μ = η^μν l_ν.
l_upper = eta * l_lower
g_inv = eta - (2 * M / r) * l_upper * l_upper.T


def christoffel():
    dg = [[[sp.diff(g[a, b], X[n]) for b in range(4)] for a in range(4)] for n in range(4)]
    return [
        [
            [
                sum(g_inv[m, n] * (dg[a][n][b] + dg[b][n][a] - dg[n][a][b]) for n in range(4)) / 2
                for b in range(4)
            ]
            for a in range(4)
        ]
        for m in range(4)
    ]


def ricci(G):
    def R(a, b):
        return sum(
            sp.diff(G[m][a][b], X[m])
            - sp.diff(G[m][a][m], X[b])
            + sum(G[m][m][n] * G[n][a][b] - G[m][b][n] * G[n][a][m] for n in range(4))
            for m in range(4)
        )

    return [[R(a, b) for b in range(4)] for a in range(4)]


def random_points(n, seed=1):
    rng = random.Random(seed)
    while n:
        p = [rng.uniform(-6, 6) for _ in range(3)]
        if sum(c * c for c in p) > 0.25:  # stay away from the singularity
            n -= 1
            yield p


def test_inverse_is_exact():
    ident = sp.simplify(g * g_inv)
    assert ident == sp.eye(4)


def test_vacuum_einstein_equations():
    Ric = ricci(christoffel())
    f = sp.lambdify((M, x, y, z), sp.Matrix(Ric), "mpmath")
    for p in random_points(5):
        vals = f(1.3, *p)
        worst = max(abs(complex(v)) for v in vals)
        assert worst < 1e-10, f"Ricci component {worst} at {p}"


def test_static_clock_rate():
    # A clock at fixed (x, y, z) ticks at √(−g_tt) = √(1 − 2M/r) per unit t, as in Schwarzschild.
    assert sp.simplify(-g[0, 0] - (1 - 2 * M / r)) == 0


if __name__ == "__main__":
    test_inverse_is_exact()
    test_vacuum_einstein_equations()
    test_static_clock_rate()
    print("Kerr–Schild metric checks passed")
