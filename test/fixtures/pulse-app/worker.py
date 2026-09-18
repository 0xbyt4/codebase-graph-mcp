import time


def compute(n):
    total = 0
    for i in range(n):
        total += i * i
    return total


def wait_a_bit():
    time.sleep(0.15)
