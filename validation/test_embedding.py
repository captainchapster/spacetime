"""
Symbolic check of the time-warp embedding (app/src/physics/embedding.ts).

Static chart: ds² = −q dt² + dr²/q. A radial geodesic with energy E = q dt/dτ has
    (dr/dt)² = q² (E² − q) / E².
On the surface dσ² = h dt² + k dr², a geodesic with Clairaut constant K = h dt/dσ has
    (dr/dt)² = h (h − K²) / (k K²).
With h = q/(aq − 1), k = 1/(q(aq − 1)²) and 1/K² = a − 1/E², the two agree for every q
(i.e. any metric of this form, Schwarzschild included) and every E: same curves.
"""

import sympy as sp

q, a, E = sp.symbols("q a E", positive=True)
h = q / (a * q - 1)
k = 1 / (q * (a * q - 1) ** 2)
K2 = 1 / (a - 1 / E**2)


def test_free_fall_and_surface_geodesics_have_the_same_shape():
    spacetime = q**2 * (E**2 - q) / E**2
    surface = h * (h - K2) / (k * K2)
    assert sp.simplify(spacetime - surface) == 0


def test_turning_points_coincide():
    # Spacetime: dr/dt = 0 where q = E². Surface: where h = K².
    assert sp.simplify((h - K2).subs(q, E**2)) == 0


def test_light_is_the_high_energy_limit():
    # Radial light has (dr/dt)² = q²; the surface curves approach that as E → ∞ (K² → 1/a).
    surface = h * (h - K2) / (k * K2)
    assert sp.simplify(sp.limit(surface, E, sp.oo) - q**2) == 0
