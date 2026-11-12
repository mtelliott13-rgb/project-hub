# Market Data Pipeline

Market-data collector and paper-trading system. Simulated trades only, no real money. (Sample notes, made up.)

- Collector polls quotes every minute while the market is open and stores them locally.
- Paper strategy v2: enter on a volume spike above 3× the 20-day average, exit after 2 days or −5%.
- Last week's backtest: 41 trades, 54% winners. Too few trades to trust yet.
