"""Request shapes for the working-tree / saved-database routes."""
from pydantic import BaseModel


class SaveInterfaceRepresentationRequest(BaseModel):
    """Body of POST /interface-representations: the name for a new saved copy of the working tree."""

    name: str
