import asyncio


async def ticker():
    while True:
        await asyncio.sleep(0.05)


async def serve(seconds):
    task = asyncio.create_task(ticker())
    await asyncio.sleep(seconds)
    task.cancel()
