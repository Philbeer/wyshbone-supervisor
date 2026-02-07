## Tower Judgement Invariant

Tower is a required dependency for agent execution in production.

- Stub judgement mode is development-only
- In production, Supervisor must fail loudly if Tower is unavailable or misconfigured
- Silent fallback to stub behaviour is forbidden
- If Tower cannot be reached, runs must halt rather than continue unjudged

This invariant exists to guarantee that agent behaviour is real, inspectable, and not simulated.
