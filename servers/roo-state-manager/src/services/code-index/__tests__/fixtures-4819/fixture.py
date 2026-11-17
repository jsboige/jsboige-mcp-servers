"""#4819 parity fixture (python) — deterministic, never edit: goldens freeze this."""


class Calculator:
    """A tiny calculator used as a tree-sitter python fixture."""

    def add(self, a, b):
        return a + b

    def multiply(self, a, b):
        """Oversized method: docstring plus body push past the chunk threshold."""
        steps = []
        for i in range(0, 12):
            steps.append(
                f"step-{i:02d}: multiply {a} by {b} then fold the result back "
                "into the accumulator before moving on to the next pass"
            )
        steps.append("padding line to help the fixture cross the chunk threshold")
        steps.append("another padding line, because parity needs realistic bulk")
        steps.append("a third padding line, deterministic and boring on purpose")
        steps.append("a fourth padding line, still deterministic, still boring")
        steps.append("a fifth padding line, enough said about padding lines now")
        return a * b


def module_helper(name: str) -> str:
    return f"helper-{name}"


def tiny():
    return 0
