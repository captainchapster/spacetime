"""
Reference geodesics in plain Schwarzschild coordinates (t, r, φ), integrated with SciPy.

This shares no code and no coordinates with the app. It checks the closed-form results
the app's TypeScript tests compare against (app/src/physics/orbits.ts, app/test/), so a
mistake in those formulas can't hide behind a matching mistake in the integrator.
"""

import math

import numpy as np
from scipy.integrate import quad, solve_ivp

M = 1.0


def bound_orbit(r1, r2):
    """E, L for a bound orbit with turning points r1 < r2 (same derivation as orbits.ts)."""
    L2 = 2 * M * (1 / r1 - 1 / r2) / ((1 - 2 * M / r1) / r1**2 - (1 - 2 * M / r2) / r2**2)
    E = math.sqrt((1 - 2 * M / r1) * (1 + L2 / r1**2))
    return E, math.sqrt(L2)


def periapsis_advance_exact(r1, r2):
    """Δφ per orbit from the turning-point integral, done with adaptive quadrature."""
    u1, u2 = 1 / r1, 1 / r2
    u3 = 1 / (2 * M) - u1 - u2
    val, _ = quad(lambda c: 1 / math.sqrt(2 * M * (u3 - (u2 + (u1 - u2) * math.sin(c) ** 2))), 0, math.pi / 2)
    return 4 * val - 2 * math.pi


def equatorial_rhs(_, s, E, L):
    """Second-order radial equation d²r/dτ² = −M/r² + L²/r³ − 3ML²/r⁴, plus φ and t."""
    t, r, pr, phi = s
    return [
        E / (1 - 2 * M / r),
        pr,
        -M / r**2 + L**2 / r**3 - 3 * M * L**2 / r**4,
        L / r**2,
    ]


def test_turning_points_and_precession():
    r1, r2 = 8.0, 20.0
    E, L = bound_orbit(r1, r2)

    def periapsis(_, s, *args):
        return s[2]  # dr/dτ = 0 going from falling to rising

    periapsis.direction = 1
    sol = solve_ivp(
        equatorial_rhs, (0, 5000), [0, r1, 0, 0], args=(E, L), events=periapsis, rtol=1e-12, atol=1e-12, dense_output=True
    )
    r = sol.sol(np.linspace(0, sol.t[-1], 20000))[1]
    assert abs(r.min() - r1) < 1e-6 and abs(r.max() - r2) < 1e-6

    phis = [ev[3] for ev in sol.y_events[0] if ev[3] > 1]
    measured = phis[0] - 2 * math.pi
    assert abs(measured - periapsis_advance_exact(r1, r2)) < 1e-8
    # And the weak-field textbook estimate 6πM/p is in the right ballpark at this strong field.
    p = 2 * r1 * r2 / (r1 + r2)
    assert 1.0 < measured / (6 * math.pi * M / p) < 2.0


def test_app_simpson_matches_quadrature():
    """The app uses Simpson's rule for the same integral; check it reaches quad's accuracy."""
    r1, r2 = 8.0, 20.0
    u1, u2 = 1 / r1, 1 / r2
    u3 = 1 / (2 * M) - u1 - u2
    f = lambda c: 1 / math.sqrt(2 * M * (u3 - (u2 + (u1 - u2) * math.sin(c) ** 2)))
    n = 2000
    h = math.pi / 2 / n
    s = f(0) + f(math.pi / 2) + sum((4 if k % 2 else 2) * f(k * h) for k in range(1, n))
    assert abs((4 * s * h / 3 - 2 * math.pi) - periapsis_advance_exact(r1, r2)) < 1e-10


def test_radial_infall_proper_time():
    """Falling from rest at r0 reaches r = 0 after τ = (π/2)√(r0³/2M)."""
    r0 = 10.0
    hit = lambda _, s: s[0] - 1e-3
    hit.terminal = True
    # Radial equation only: Schwarzschild t diverges at the horizon, but r(τ) sails through.
    sol = solve_ivp(lambda _, s: [s[1], -M / s[0] ** 2], (0, 100), [r0, 0], events=hit, rtol=1e-11, atol=1e-12)
    assert abs(sol.t_events[0][0] - math.pi / 2 * math.sqrt(r0**3 / (2 * M))) < 1e-3


def test_photon_capture_threshold():
    """Light with impact parameter b < 3√3 M is captured; just above, it escapes."""
    b_crit = 3 * math.sqrt(3) * M

    def fate(b):
        # Null geodesic in u = 1/r: d²u/dφ² = 3Mu² − u, starting far away moving inward.
        u0 = 1 / 1000
        du0 = math.sqrt(max(1 / b**2 - u0**2 * (1 - 2 * M * u0), 0))
        captured = lambda _, s: s[0] - 1 / (2 * M)
        captured.terminal = True
        escaped = lambda _, s: s[0] - u0 / 2
        escaped.terminal = True
        sol = solve_ivp(
            lambda _, s: [s[1], 3 * M * s[0] ** 2 - s[0]], (0, 50), [u0, du0], events=[captured, escaped], rtol=1e-12, atol=1e-14
        )
        return "captured" if len(sol.t_events[0]) else "escaped"

    assert fate(b_crit * 0.99) == "captured"
    assert fate(b_crit * 1.01) == "escaped"
