# MCP to Argolink mapping

The MCP layer is a thin adapter. It validates tool inputs, calls the documented Argolink routes, and returns structured errors. It does not invent model IDs, retry forever, or expose raw credentials to the model context.