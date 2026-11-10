"""Errors shared by the dump CLIs and the hub.

They live here, not in ``dump.py``: run as ``python -m caseguard_ai.ingest.dump``, that module is
``__main__``, and a class defined there would differ from the one ``hub.py`` raises.
"""


class DumpRefused(Exception):
    """The dump can't be built, published or restored safely; the message says why and what to do."""
