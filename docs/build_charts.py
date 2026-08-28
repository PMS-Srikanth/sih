# -*- coding: utf-8 -*-
"""
Charts for the presenter handbook and the deck.

Two kinds, and they are labelled differently on purpose:
  MEASURED      — numbers our own harness produces. Reproducible on the spot.
  ARCHITECTURAL — what each design can and cannot do, from public documentation.
                  NOT a benchmark. We have not run anybody else's code.
"""
import os
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import Rectangle, FancyArrowPatch

OUT = r"c:\Users\srika\OneDrive\Desktop\sih-p\docs\charts"
os.makedirs(OUT, exist_ok=True)

INK, INK2, INK3 = "#15191C", "#46525A", "#8A959C"
TEAL, GREEN, RED, AMBER, INDIGO = "#0A6E78", "#15803D", "#A32B20", "#B4610F", "#4A42B8"
GRID, PAPER = "#DCE4E9", "#FFFFFF"

plt.rcParams.update({
    "font.family": "DejaVu Sans",
    "figure.facecolor": PAPER,
    "axes.facecolor": PAPER,
    "savefig.facecolor": PAPER,
    "axes.edgecolor": GRID,
    "text.color": INK,
    "axes.labelcolor": INK2,
    "xtick.color": INK2,
    "ytick.color": INK2,
})


def save(fig, name):
    path = os.path.join(OUT, name)
    fig.savefig(path, dpi=200, bbox_inches="tight", pad_inches=0.18)
    plt.close(fig)
    print("  ", name)


# ── 1 · how much leaves the machine, per step ────────────────────────────────
def chart_payload():
    fig, ax = plt.subplots(figsize=(8.6, 3.0))
    labels = ["CORDON\nstructure + handles", "Screenshot agent\n(low quality)",
              "Screenshot agent\n(full page)"]
    kb = [10, 200, 2000]
    colors = [TEAL, AMBER, RED]

    bars = ax.barh(labels, kb, color=colors, height=0.55, zorder=3)
    ax.set_xscale("log")
    ax.set_xlim(5, 5000)
    ax.set_xlabel("Kilobytes sent per step  (log scale)", fontsize=9.5)
    ax.xaxis.grid(True, color=GRID, linewidth=0.8, zorder=0)
    ax.set_axisbelow(True)
    for sp in ("top", "right", "left"):
        ax.spines[sp].set_visible(False)

    for b, v in zip(bars, kb):
        ax.text(v * 1.15, b.get_y() + b.get_height() / 2,
                f"~{v} KB" if v < 1000 else f"~{v/1000:.0f} MB",
                va="center", fontsize=10, fontweight="bold", color=INK)

    ax.set_title("How much data leaves your machine on every single step",
                 fontsize=12.5, fontweight="bold", pad=12, loc="left")
    ax.text(0, 1.02, "ARCHITECTURAL — typical payload by design, not a benchmark",
            transform=ax.transAxes, fontsize=8, color=INK3)
    ax.tick_params(labelsize=9)
    save(fig, "01_payload.png")


# ── 2 · what actually crosses the boundary ───────────────────────────────────
def chart_leaves():
    rows = ["Screenshot of your screen", "Values you typed into fields",
            "Your password", "Your face / ID document"]
    cols = ["CORDON", "Computer-use\nagents", "Server PII\ntools", "Password\nmanagers"]
    # 0 = never leaves, 1 = leaves, 2 = not applicable
    grid = [[0, 1, 2, 2],
            [0, 1, 1, 0],
            [0, 1, 1, 0],
            [0, 1, 1, 2]]
    note = [["masked only", "full frame", "—", "—"],
            ["never", "yes", "yes, then\nredacted", "never"],
            ["never read", "yes", "depends", "never"],
            ["black box", "uploaded", "text only", "—"]]

    fig, ax = plt.subplots(figsize=(9.6, 3.7))
    fill = {0: "#E4F1E8", 1: "#FBE9E7", 2: "#F2F4F5"}
    edge = {0: GREEN, 1: RED, 2: "#C9D2D8"}
    txt = {0: GREEN, 1: RED, 2: INK3}

    PITCH = 1.22   # column spacing; boxes are narrower than the pitch so headers breathe
    for r in range(len(rows)):
        for c in range(len(cols)):
            v = grid[r][c]
            ax.add_patch(Rectangle((c * PITCH, -r), 1.10, 0.86, facecolor=fill[v],
                                   edgecolor=edge[v], linewidth=1.4))
            ax.text(c * PITCH + 0.55, -r + 0.43, note[r][c], ha="center", va="center",
                    fontsize=9, fontweight="bold", color=txt[v], linespacing=1.3)

    for c, name in enumerate(cols):
        ax.text(c * PITCH + 0.55, 1.16, name, ha="center", va="center", fontsize=9.5,
                fontweight="bold", color=TEAL if c == 0 else INK2, linespacing=1.3)
    for r, name in enumerate(rows):
        ax.text(-0.18, -r + 0.43, name, ha="right", va="center", fontsize=10,
                fontweight="bold", color=INK)

    ax.set_xlim(-3.7, len(cols) * PITCH); ax.set_ylim(-len(rows) + 0.9, 2.0)
    ax.axis("off")
    ax.text(-3.7, 1.88, "What actually leaves your machine",
            fontsize=13, fontweight="bold", color=INK)
    ax.text(-3.7, 1.62, "ARCHITECTURAL — green means it never leaves, red means it does",
            fontsize=8.5, color=INK3)
    save(fig, "02_what_leaves.png")


# ── 3 · where redaction happens on the timeline ──────────────────────────────
def chart_timeline():
    fig, ax = plt.subplots(figsize=(8.6, 3.2))

    lanes = [("CORDON", TEAL, 0.30, "redacts HERE — before the network"),
             ("Computer-use agents", RED, 0.55, "never redacts"),
             ("Server PII tools", AMBER, 0.80, "redacts HERE — after it arrived")]

    for name, col, pos, _ in lanes:
        y = 2 - list(l[0] for l in lanes).index(name)
        ax.plot([0.05, 0.95], [y, y], color=GRID, linewidth=8, solid_capstyle="round", zorder=1)
        ax.text(0.03, y, name, ha="right", va="center", fontsize=9.5,
                fontweight="bold", color=col)
        ax.plot([pos], [y], marker="o", markersize=13, color=col, zorder=3)

    # boundary
    ax.axvline(0.5, color=RED, linestyle="--", linewidth=1.6, zorder=2)
    ax.text(0.5, 2.86, "NETWORK BOUNDARY", ha="center", fontsize=9,
            fontweight="bold", color=RED)
    ax.text(0.26, 2.55, "◀  on your device", ha="center", fontsize=9.5, color=INK3)
    ax.text(0.76, 2.55, "on the server  ▶", ha="center", fontsize=9.5, color=INK3)

    ax.annotate("redacted before\nanything is sent", xy=(0.30, 2), xytext=(0.16, 1.45),
                fontsize=8.6, color=TEAL, fontweight="bold", ha="center",
                arrowprops=dict(arrowstyle="->", color=TEAL, lw=1.2))
    ax.annotate("nothing is ever removed", xy=(0.57, 1), xytext=(0.78, 0.52),
                fontsize=8.8, color=RED, fontweight="bold", ha="center",
                arrowprops=dict(arrowstyle="->", color=RED, lw=1.2))
    ax.annotate("data already left\nbefore it was cleaned", xy=(0.80, 0), xytext=(0.80, -0.62),
                fontsize=8.6, color=AMBER, fontweight="bold", ha="center",
                arrowprops=dict(arrowstyle="->", color=AMBER, lw=1.2))

    ax.set_xlim(-0.30, 1.06); ax.set_ylim(-0.95, 3.25)
    ax.axis("off")
    ax.text(-0.30, 3.18, "WHEN each approach removes your personal data",
            fontsize=13, fontweight="bold", color=INK)
    save(fig, "03_timeline.png")


# ── 4 · our measured numbers ─────────────────────────────────────────────────
def chart_measured():
    fig, axes = plt.subplots(1, 4, figsize=(9.2, 2.5))

    def donut(ax, frac, big, small, color):
        ax.pie([frac, 1 - frac], colors=[color, "#EDF1F3"], startangle=90,
               counterclock=False, wedgeprops=dict(width=0.34, edgecolor=PAPER, linewidth=2))
        ax.text(0, 0.08, big, ha="center", va="center", fontsize=15,
                fontweight="bold", color=color)
        ax.text(0, -0.32, small, ha="center", va="center", fontsize=8, color=INK2)
        ax.set(aspect="equal")

    donut(axes[0], 0.92, "92%", "of each screen\nnever analysed", TEAL)
    donut(axes[1], 1.00, "1.000", "PII precision\nand recall", GREEN)
    donut(axes[2], 5 / 9, "5 of 9", "tasks with zero\nnetwork calls", INDIGO)
    donut(axes[3], 0.012, "1.2 MB", "on-device\nvision model", AMBER)

    fig.suptitle("MEASURED — every figure reproducible with npm run eval",
                 fontsize=11, fontweight="bold", color=INK, y=1.04)
    save(fig, "04_measured.png")


# ── 5 · safety features present or absent ────────────────────────────────────
def chart_safety():
    feats = ["Verifier that can\nrefuse to send", "Per-step receipt\nyou can read",
             "Prompt-injection\ndefence", "Confirms the value\nactually landed",
             "Human approval before\nirreversible actions", "Local data encrypted\nat rest"]
    cordon = [1, 1, 1, 1, 1, 1]
    others = [0, 0, 0.4, 0, 0.5, 0.5]

    y = range(len(feats))
    fig, ax = plt.subplots(figsize=(8.6, 3.6))
    ax.barh([i + 0.19 for i in y], cordon, height=0.34, color=TEAL, label="CORDON", zorder=3)
    ax.barh([i - 0.19 for i in y], others, height=0.34, color="#C9D2D8",
            label="Typical alternatives", zorder=3)

    ax.set_yticks(list(y)); ax.set_yticklabels(feats, fontsize=9)
    ax.set_xlim(0, 1.28); ax.set_xticks([0, 0.5, 1])
    ax.set_xticklabels(["absent", "partial", "present"], fontsize=9)
    ax.xaxis.grid(True, color=GRID, linewidth=0.8, zorder=0)
    ax.set_axisbelow(True)
    for sp in ("top", "right", "left"):
        ax.spines[sp].set_visible(False)
    ax.legend(loc="lower right", fontsize=9, frameon=False)
    ax.set_title("Safety features: present, partial, or absent",
                 fontsize=12.5, fontweight="bold", pad=14, loc="left")
    ax.text(0, 1.03, "ARCHITECTURAL — from public documentation, not measured",
            transform=ax.transAxes, fontsize=8, color=INK3)
    ax.invert_yaxis()
    save(fig, "05_safety.png")


# ── 6 · where the work happens ───────────────────────────────────────────────
def chart_workload():
    fig, ax = plt.subplots(figsize=(8.6, 2.6))
    stages = ["Read the\nscreen", "Find personal\ndata", "Redact and\nmask", "Plan the\nnext step",
              "Type and\nclick"]
    client = [100, 100, 100, 44, 100]     # 5 of 9 tasks resolve locally ≈ 44%
    server = [0, 0, 0, 56, 0]

    x = range(len(stages))
    ax.bar(x, client, width=0.56, color=TEAL, label="On your device", zorder=3)
    ax.bar(x, server, width=0.56, bottom=client, color=INDIGO,
           label="Sent to the server", zorder=3)

    for i, (c, s) in enumerate(zip(client, server)):
        ax.text(i, c / 2, f"{c}%", ha="center", va="center", fontsize=10,
                fontweight="bold", color="white")
        if s:
            ax.text(i, c + s / 2, f"{s}%", ha="center", va="center", fontsize=10,
                    fontweight="bold", color="white")

    ax.set_xticks(list(x)); ax.set_xticklabels(stages, fontsize=9)
    ax.set_ylim(0, 112); ax.set_yticks([])
    for sp in ("top", "right", "left"):
        ax.spines[sp].set_visible(False)
    ax.legend(loc="upper center", bbox_to_anchor=(0.5, -0.2), ncol=2, fontsize=9, frameon=False)
    ax.set_title("Which part of the job runs where",
                 fontsize=12.5, fontweight="bold", pad=12, loc="left")
    ax.text(0, 1.03, "Only planning ever reaches the server — and only when the device cannot decide alone",
            transform=ax.transAxes, fontsize=8, color=INK3)
    save(fig, "06_workload.png")


print("charts ->")
chart_payload()
chart_leaves()
chart_timeline()
chart_measured()
chart_safety()
chart_workload()
print("done")
