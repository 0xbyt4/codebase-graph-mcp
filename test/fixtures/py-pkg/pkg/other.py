"""Docstring with a fake import:
from pkg.fake import nothing
"""
from typing import TYPE_CHECKING
from .sub import x  # trailing comment
if TYPE_CHECKING: from pkg.core import Core
a = 1
b = 2
