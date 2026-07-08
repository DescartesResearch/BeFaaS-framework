from datetime import datetime
from typing import Optional, List

from sqlalchemy import (
    String, Integer, BigInteger, SmallInteger, Boolean, Text,
    Float, Numeric, ForeignKey, Index, UniqueConstraint,
    create_engine, text, delete
)
from sqlalchemy.orm import (
    DeclarativeBase, Mapped, mapped_column, relationship,
    Session
)


class Base(DeclarativeBase):
    """Base class for all models."""
    pass

class Experiment(Base):
    __tablename__ = "experiments"
    __table_args__ = (
        Index("idx_exp_arch", "architecture"),
        Index("idx_exp_auth", "auth_strategy"),
        Index("idx_exp_arch_auth", "architecture", "auth_strategy"),
    )

    id: Mapped[int] = mapped_column(
        primary_key=True,
        comment="Auto-incrementing primary key"
    )
    name: Mapped[str] = mapped_column(
        String(255), unique=True, nullable=False,
        comment="Unique experiment name from directory, e.g. faas_none_512MB_minimal_2026-01-09T22-48-43-424Z"
    )

    # === From directory name parsing ===
    architecture: Mapped[str] = mapped_column(
        String(50), nullable=False,
        comment="Cloud architecture: 'faas' (Lambda), 'microservices' (ECS multi-service), 'monolith' (ECS single-service)"
    )
    auth_strategy: Mapped[str] = mapped_column(
        String(50), nullable=False,
        comment="Authentication method: 'none', 'service-integrated' (JWT in handler), 'service-integrated-manual', 'edge' (auth at gateway), 'edge-selective' (Lambda@Edge only for protected paths)"
    )
    run_timestamp: Mapped[Optional[datetime]] = mapped_column(
        comment="When the experiment was executed, parsed from directory name timestamp"
    )

    # === From hardware_config.json ===
    aws_service: Mapped[Optional[str]] = mapped_column(
        String(50),
        comment="AWS service used: 'lambda' for FaaS, 'fargate' for ECS-based architectures"
    )
    ram_in_mb: Mapped[int] = mapped_column(
        Integer, nullable=False,
        comment="Memory allocation in MB. For Lambda: function memory. For Fargate: container memory."
    )
    bundle_mode: Mapped[Optional[str]] = mapped_column(
        String(50),
        comment="FaaS only: How functions are packaged - 'individual' (one per function) or 'shared' (bundled)"
    )
    cpu_in_vcpu: Mapped[Optional[float]] = mapped_column(
        Numeric(4, 2),
        comment="ECS only: CPU allocation in vCPU units (e.g., 0.25, 0.5, 1.0, 2.0)"
    )
    cpu_units: Mapped[Optional[int]] = mapped_column(
        Integer,
        comment="ECS only: CPU in AWS CPU units (256=0.25 vCPU, 512=0.5, 1024=1.0, etc.)"
    )
    # === Algorithm fields (service-integrated-manual auth) ===
    password_hash_algorithm: Mapped[Optional[str]] = mapped_column(
        String(50),
        comment="Password hashing algorithm: 'bcrypt' (legacy) or 'argon2id' (current). Only for service-integrated-manual auth."
    )
    jwt_sign_algorithm: Mapped[Optional[str]] = mapped_column(
        String(50),
        comment="JWT signing algorithm: 'HS256' (legacy) or 'EdDSA' (current). Only for service-integrated-manual auth."
    )
    with_cloudfront: Mapped[Optional[bool]] = mapped_column(
        Boolean, default=False,
        comment="Whether CloudFront was deployed as passthrough proxy (--with-cloudfront flag). True for edge/edge-selective (implicit) and explicit proxy deployments."
    )
    auth_granularity: Mapped[Optional[str]] = mapped_column(
        String(20), default='per-function',
        comment="Where JWT verification happens: 'per-function' (every handler verifies, k=n_calls per request) or 'per-service' (one verification per service boundary, k=1 monolith / k=d microservices). FaaS is identical in both modes."
    )

    # === From benchmark_configuration.json ===
    http_timeout_seconds: Mapped[Optional[int]] = mapped_column(
        Integer,
        comment="HTTP request timeout in seconds used by Artillery load generator"
    )

    # === From experiment_start_time.txt ===
    start_timestamp_ms: Mapped[Optional[int]] = mapped_column(
        BigInteger,
        comment="Unix timestamp in milliseconds when infrastructure deployment completed and benchmark started"
    )

    # === Computed during import ===
    benchmark_start_ms: Mapped[Optional[int]] = mapped_column(
        BigInteger,
        comment="Unix timestamp (ms) of the first request in the benchmark (computed from requests table)"
    )
    benchmark_end_ms: Mapped[Optional[int]] = mapped_column(
        BigInteger,
        comment="Unix timestamp (ms) of the last request in the benchmark (computed from requests table)"
    )

    # === From pricing/pricing.json metadata ===
    pricing_region: Mapped[Optional[str]] = mapped_column(
        String(20),
        comment="AWS region for pricing calculations, e.g. 'eu-central-1'"
    )
    pricing_start_time: Mapped[Optional[datetime]] = mapped_column(
        comment="Start time of the pricing calculation window"
    )
    pricing_end_time: Mapped[Optional[datetime]] = mapped_column(
        comment="End time of the pricing calculation window"
    )
    pricing_duration_minutes: Mapped[Optional[float]] = mapped_column(
        Float,
        comment="Duration of the benchmark in minutes for cost calculation"
    )
    pricing_duration_hours: Mapped[Optional[float]] = mapped_column(
        Float,
        comment="Duration of the benchmark in hours for cost calculation"
    )
    pricing_collected_at: Mapped[Optional[datetime]] = mapped_column(
        comment="When pricing data was collected from AWS Cost Explorer"
    )

    # === From error_description.md ===
    error_description: Mapped[Optional[str]] = mapped_column(
        Text,
        comment="Human-written notes about any issues or anomalies during this experiment"
    )

    created_at: Mapped[datetime] = mapped_column(
        default=datetime.now,
        comment="When this record was imported into the database"
    )

    # === Relationships ===
    scaling_rules: Mapped[List["ScalingRule"]] = relationship(back_populates="experiment", cascade="all, delete-orphan")
    phases: Mapped[List["Phase"]] = relationship(back_populates="experiment", cascade="all, delete-orphan")
    requests: Mapped[List["Request"]] = relationship(back_populates="experiment", cascade="all, delete-orphan")
    lambda_executions: Mapped[List["LambdaExecution"]] = relationship(back_populates="experiment", cascade="all, delete-orphan")
    handler_events: Mapped[List["HandlerEvent"]] = relationship(back_populates="experiment", cascade="all, delete-orphan")
    container_starts: Mapped[List["ContainerStart"]] = relationship(back_populates="experiment", cascade="all, delete-orphan")
    rpc_calls: Mapped[List["RpcCall"]] = relationship(back_populates="experiment", cascade="all, delete-orphan")
    metrics_ecs: Mapped[List["MetricsEcs"]] = relationship(back_populates="experiment", cascade="all, delete-orphan")
    metrics_alb: Mapped[List["MetricsAlb"]] = relationship(back_populates="experiment", cascade="all, delete-orphan")
    edge_auth_events: Mapped[List["EdgeAuthEvent"]] = relationship(back_populates="experiment", cascade="all, delete-orphan")


class ScalingRule(Base):
    __tablename__ = "scaling_rules"
    __table_args__ = (
        UniqueConstraint("experiment_id", "service_name", "rule_type"),
        Index("idx_scaling_exp", "experiment_id"),
        Index("idx_scaling_exp_svc", "experiment_id", "service_name"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    experiment_id: Mapped[int] = mapped_column(
        ForeignKey("experiments.id", ondelete="CASCADE"), nullable=False,
        comment="Reference to parent experiment"
    )
    service_name: Mapped[str] = mapped_column(
        String(50), nullable=False,
        comment="ECS service name: 'monolith', 'frontend-service', 'product-service', 'cart-service', 'order-service', 'content-service'"
    )
    rule_type: Mapped[str] = mapped_column(
        String(20), nullable=False,
        comment="Scaling metric type: 'cpu' (CPU utilization target) or 'request_count' (ALB requests per target per minute)"
    )
    target_value: Mapped[int] = mapped_column(
        Integer, nullable=False,
        comment="Target value for the metric (e.g., 70 for 70% CPU, 2500 for requests/target/min)"
    )
    min_capacity: Mapped[Optional[int]] = mapped_column(
        Integer,
        comment="Minimum number of running tasks for this service"
    )
    max_capacity: Mapped[Optional[int]] = mapped_column(
        Integer,
        comment="Maximum number of running tasks for this service"
    )
    cpu_units: Mapped[Optional[int]] = mapped_column(
        Integer,
        comment="CPU units for this service (256=0.25 vCPU, 512=0.5, 1024=1.0)"
    )
    memory_mb: Mapped[Optional[int]] = mapped_column(
        Integer,
        comment="Memory in MB for this service"
    )
    scale_in_cooldown_sec: Mapped[Optional[int]] = mapped_column(
        Integer,
        comment="Seconds to wait after scale-in before another scale-in can occur"
    )
    scale_out_cooldown_sec: Mapped[Optional[int]] = mapped_column(
        Integer,
        comment="Seconds to wait after scale-out before another scale-out can occur"
    )

    experiment: Mapped["Experiment"] = relationship(back_populates="scaling_rules")


class Phase(Base):
    __tablename__ = "phases"
    __table_args__ = (
        UniqueConstraint("experiment_id", "phase_index"),
        Index("idx_phase_exp", "experiment_id"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    experiment_id: Mapped[int] = mapped_column(
        ForeignKey("experiments.id", ondelete="CASCADE"), nullable=False,
        comment="Reference to parent experiment"
    )
    phase_index: Mapped[int] = mapped_column(
        SmallInteger, nullable=False,
        comment="Zero-based index of the phase in execution order (0=first phase)"
    )
    phase_name: Mapped[Optional[str]] = mapped_column(
        String(100),
        comment="Human-readable phase name: 'warmup', 'baseline', 'stress', 'ramp', etc."
    )
    duration_seconds: Mapped[Optional[int]] = mapped_column(
        Integer,
        comment="Configured duration of this phase in seconds"
    )

    experiment: Mapped["Experiment"] = relationship(back_populates="phases")


class Request(Base):
    __tablename__ = "requests"
    __table_args__ = (
        Index("idx_req_exp", "experiment_id"),
        Index("idx_req_exp_ts", "experiment_id", "timestamp_ms"),
        Index("idx_req_exp_endpoint", "experiment_id", "endpoint"),
        Index("idx_req_exp_auth", "experiment_id", "auth_type"),
        Index("idx_req_exp_phase", "experiment_id", "phase_index"),
        Index("idx_req_xpair", "x_pair"),
        Index("idx_req_latency", "experiment_id", "latency_ms"),
        Index("idx_req_exp_xpair", "experiment_id", "x_pair"),
        Index("idx_req_exp_context", "experiment_id", "context_id"),
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    experiment_id: Mapped[int] = mapped_column(
        ForeignKey("experiments.id", ondelete="CASCADE"), nullable=False,
        comment="Reference to parent experiment"
    )

    # === Correlation IDs ===
    x_pair: Mapped[Optional[str]] = mapped_column(
        String(50),
        comment="Unique request ID (X-Pair header) to correlate with handler_events and rpc_calls"
    )
    context_id: Mapped[Optional[str]] = mapped_column(
        String(50),
        comment="User session context ID for tracking requests within a virtual user session"
    )

    # === Timing ===
    timestamp_ms: Mapped[int] = mapped_column(
        BigInteger, nullable=False,
        comment="Unix timestamp in milliseconds when the request was sent"
    )
    latency_ms: Mapped[Optional[float]] = mapped_column(
        Float,
        comment="End-to-end response time in milliseconds (client perspective, includes network latency)"
    )
    relative_time_ms: Mapped[Optional[float]] = mapped_column(
        Float,
        comment="Milliseconds since benchmark start (timestamp_ms - benchmark_start_ms)"
    )
    phase_relative_time_ms: Mapped[Optional[float]] = mapped_column(
        Float,
        comment="Milliseconds since the current phase started"
    )

    # === Request details ===
    endpoint: Mapped[Optional[str]] = mapped_column(
        String(200),
        comment="HTTP endpoint path, e.g. '/api/cart', '/api/products/{id}'"
    )
    status_code: Mapped[Optional[int]] = mapped_column(
        SmallInteger,
        comment="HTTP response status code (200, 401, 500, etc.). NULL if request timed out."
    )
    auth_type: Mapped[Optional[str]] = mapped_column(
        String(30),
        comment="Authentication type used: 'none', 'bearer', 'cognito', 'service-integrated-manual'. Derived from endpoint protection."
    )

    # === Error tracking ===
    is_error: Mapped[bool] = mapped_column(
        Boolean, default=False,
        comment="True if request failed (non-2xx status, timeout, or connection error)"
    )
    is_timeout: Mapped[bool] = mapped_column(
        Boolean, default=False,
        comment="True if request exceeded http_timeout_seconds and was aborted"
    )
    error_type: Mapped[Optional[str]] = mapped_column(
        String(50),
        comment="Error category: 'timeout', 'connection_refused', 'http_error', etc."
    )
    error_code: Mapped[Optional[str]] = mapped_column(
        String(50),
        comment="Specific error code: 'ETIMEDOUT', 'ECONNREFUSED', etc."
    )

    # === Phase information ===
    phase_index: Mapped[Optional[int]] = mapped_column(
        SmallInteger,
        comment="Zero-based index of the benchmark phase when this request was made"
    )
    phase_name: Mapped[Optional[str]] = mapped_column(
        String(100),
        comment="Name of the benchmark phase: 'warmup', 'baseline', 'stress', etc."
    )

    # === Computed fields (populated by joining with handler_events) ===
    handler_duration_ms: Mapped[Optional[float]] = mapped_column(
        Float,
        comment="Server-side handler execution time from handler_events (matched by x_pair)"
    )
    network_overhead_ms: Mapped[Optional[float]] = mapped_column(
        Float,
        comment="Network latency = latency_ms - handler_duration_ms. Includes API Gateway/ALB overhead."
    )

    experiment: Mapped["Experiment"] = relationship(back_populates="requests")


class LambdaExecution(Base):
    __tablename__ = "lambda_executions"
    __table_args__ = (
        Index("idx_lambda_exp", "experiment_id"),
        Index("idx_lambda_exp_fn", "experiment_id", "function_name"),
        Index("idx_lambda_exp_cold", "experiment_id", "is_cold_start"),
        Index("idx_lambda_reqid", "request_id"),
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    experiment_id: Mapped[int] = mapped_column(
        ForeignKey("experiments.id", ondelete="CASCADE"), nullable=False,
        comment="Reference to parent experiment"
    )

    request_id: Mapped[Optional[str]] = mapped_column(
        String(50),
        comment="AWS Lambda Request ID (unique per invocation). Use to correlate with handler_events.lambda_request_id"
    )
    function_name: Mapped[str] = mapped_column(
        String(50), nullable=False,
        comment="Lambda function name: 'frontend', 'cart', 'products', 'orders', 'users', etc."
    )

    timestamp_ms: Mapped[int] = mapped_column(
        BigInteger, nullable=False,
        comment="Unix timestamp (ms) when the REPORT log was emitted (end of invocation)"
    )
    duration_ms: Mapped[Optional[float]] = mapped_column(
        Float,
        comment="Actual execution duration in milliseconds"
    )
    billed_duration_ms: Mapped[Optional[float]] = mapped_column(
        Float,
        comment="Billed duration in milliseconds (rounded up, minimum 1ms). This is what AWS charges for."
    )
    init_duration_ms: Mapped[Optional[float]] = mapped_column(
        Float,
        comment="Cold start initialization time in ms. Only present when is_cold_start=True. Includes loading code, initializing runtime."
    )

    memory_size_mb: Mapped[Optional[int]] = mapped_column(
        SmallInteger,
        comment="Configured Lambda memory in MB (128-10240)"
    )
    max_memory_used_mb: Mapped[Optional[int]] = mapped_column(
        SmallInteger,
        comment="Peak memory used during this invocation in MB"
    )

    is_cold_start: Mapped[bool] = mapped_column(
        Boolean, default=False,
        comment="True if this invocation required container initialization (init_duration_ms > 0)"
    )
    relative_time_ms: Mapped[Optional[float]] = mapped_column(
        Float,
        comment="Milliseconds since benchmark start"
    )

    experiment: Mapped["Experiment"] = relationship(back_populates="lambda_executions")


class HandlerEvent(Base):
    __tablename__ = "handler_events"
    __table_args__ = (
        Index("idx_handler_exp", "experiment_id"),
        Index("idx_handler_exp_fn", "experiment_id", "function_name"),
        Index("idx_handler_xpair", "x_pair"),
        Index("idx_handler_exp_auth", "experiment_id", "auth_type"),
        Index("idx_handler_exp_xpair", "experiment_id", "x_pair"),
        Index("idx_handler_exp_context", "experiment_id", "context_id"),
        Index("idx_handler_exp_phase_idx", "experiment_id", "phase_index"),
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    experiment_id: Mapped[int] = mapped_column(
        ForeignKey("experiments.id", ondelete="CASCADE"), nullable=False,
        comment="Reference to parent experiment"
    )

    # === Correlation IDs ===
    x_pair: Mapped[Optional[str]] = mapped_column(
        String(50),
        comment="Request correlation ID (X-Pair header). Join with requests.x_pair for end-to-end analysis."
    )
    context_id: Mapped[Optional[str]] = mapped_column(
        String(50),
        comment="User session context ID"
    )
    lambda_request_id: Mapped[Optional[str]] = mapped_column(
        String(50),
        comment="AWS Lambda Request ID. Join with lambda_executions.request_id for platform metrics. NULL for ECS."
    )

    # === Handler details ===
    function_name: Mapped[str] = mapped_column(
        String(50), nullable=False,
        comment="Function/service name: 'frontend', 'cart', 'products', 'orders', 'users'"
    )
    route: Mapped[Optional[str]] = mapped_column(
        String(100),
        comment="HTTP route pattern, e.g. 'GET /api/cart', 'POST /api/orders'"
    )
    status_code: Mapped[Optional[int]] = mapped_column(
        SmallInteger,
        comment="HTTP response status code returned by the handler"
    )
    is_cold_start: Mapped[bool] = mapped_column(
        Boolean, default=False,
        comment="True if this was the first request to this container/function instance (application-level detection)"
    )
    request_count: Mapped[Optional[int]] = mapped_column(
        Integer,
        comment="Number of requests this container has processed (used for cold start detection)"
    )

    # === Timing ===
    timestamp_ms: Mapped[int] = mapped_column(
        BigInteger, nullable=False,
        comment="Unix timestamp (ms) when the handler started processing"
    )
    duration_ms: Mapped[Optional[float]] = mapped_column(
        Float,
        comment="Handler execution time in milliseconds (business logic only, excludes network/platform overhead)"
    )

    # === Context ===
    auth_type: Mapped[Optional[str]] = mapped_column(
        String(30),
        comment="Authentication type: 'none', 'bearer', 'cognito', 'service-integrated-manual'"
    )
    phase_index: Mapped[Optional[int]] = mapped_column(
        SmallInteger,
        comment="Benchmark phase index (0-based)"
    )
    phase_name: Mapped[Optional[str]] = mapped_column(
        String(100),
        comment="Benchmark phase name: 'warmup', 'baseline', 'stress'"
    )
    relative_time_ms: Mapped[Optional[float]] = mapped_column(
        Float,
        comment="Milliseconds since benchmark start"
    )
    phase_relative_time_ms: Mapped[Optional[float]] = mapped_column(
        Float,
        comment="Milliseconds since current phase started"
    )

    is_protected_endpoint: Mapped[Optional[bool]] = mapped_column(
        Boolean,
        comment="True if this endpoint requires authentication (useful for auth overhead analysis)"
    )

    experiment: Mapped["Experiment"] = relationship(back_populates="handler_events")


class ContainerStart(Base):
    __tablename__ = "container_starts"
    __table_args__ = (
        Index("idx_cold_exp", "experiment_id"),
        Index("idx_cold_exp_fn", "experiment_id", "function_name"),
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    experiment_id: Mapped[int] = mapped_column(
        ForeignKey("experiments.id", ondelete="CASCADE"), nullable=False,
        comment="Reference to parent experiment"
    )

    lambda_request_id: Mapped[Optional[str]] = mapped_column(
        String(50),
        comment="AWS Lambda Request ID for correlation with lambda_executions"
    )
    function_name: Mapped[str] = mapped_column(
        String(50), nullable=False,
        comment="Function/service name that experienced the cold start"
    )
    deployment_id: Mapped[Optional[str]] = mapped_column(
        String(50),
        comment="Unique identifier for this container/function instance"
    )

    timestamp_ms: Mapped[int] = mapped_column(
        BigInteger, nullable=False,
        comment="Unix timestamp (ms) when the cold start was detected"
    )
    container_start_time_ms: Mapped[Optional[int]] = mapped_column(
        BigInteger,
        comment="Unix timestamp (ms) when the container started initializing"
    )
    relative_time_ms: Mapped[Optional[float]] = mapped_column(
        Float,
        comment="Milliseconds since benchmark start"
    )

    experiment: Mapped["Experiment"] = relationship(back_populates="container_starts")


class RpcCall(Base):
    __tablename__ = "rpc_calls"
    __table_args__ = (
        Index("idx_rpc_exp", "experiment_id"),
        Index("idx_rpc_exp_dir", "experiment_id", "direction"),
        Index("idx_rpc_exp_fn", "experiment_id", "function_name"),
        Index("idx_rpc_xpair", "x_pair"),
        Index("idx_rpc_exp_xpair", "experiment_id", "x_pair"),
        Index("idx_rpc_exp_context", "experiment_id", "context_id"),
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    experiment_id: Mapped[int] = mapped_column(
        ForeignKey("experiments.id", ondelete="CASCADE"), nullable=False,
        comment="Reference to parent experiment"
    )

    direction: Mapped[str] = mapped_column(
        String(5), nullable=False,
        comment="'out' = outgoing call (caller side), 'in' = incoming call (callee side)"
    )

    # === Correlation IDs ===
    x_pair: Mapped[Optional[str]] = mapped_column(
        String(50),
        comment="Parent request's correlation ID"
    )
    context_id: Mapped[Optional[str]] = mapped_column(
        String(50),
        comment="User session context ID"
    )
    lambda_request_id: Mapped[Optional[str]] = mapped_column(
        String(50),
        comment="AWS Lambda Request ID of the function making/receiving the call"
    )

    # === Call details ===
    function_name: Mapped[str] = mapped_column(
        String(50), nullable=False,
        comment="Name of the function logging this event (caller for 'out', callee for 'in')"
    )
    target_function: Mapped[Optional[str]] = mapped_column(
        String(50),
        comment="For direction='out': name of the function being called"
    )
    call_x_pair: Mapped[Optional[str]] = mapped_column(
        String(50),
        comment="For direction='out': the x_pair assigned to this downstream call (use to find callee's handler_event)"
    )

    call_type: Mapped[Optional[str]] = mapped_column(
        String(20),
        comment="Type of call: 'http', 'invoke' (Lambda direct invoke), etc."
    )
    duration_ms: Mapped[Optional[float]] = mapped_column(
        Float,
        comment="For direction='out': round-trip time of the call in milliseconds"
    )
    success: Mapped[bool] = mapped_column(
        Boolean, default=True,
        comment="Whether the call succeeded"
    )
    is_cold_start: Mapped[bool] = mapped_column(
        Boolean, default=False,
        comment="For direction='in': whether this call triggered a cold start in the callee"
    )

    # === Timing ===
    timestamp_ms: Mapped[int] = mapped_column(
        BigInteger, nullable=False,
        comment="Unix timestamp (ms) when the call was initiated (out) or received (in)"
    )
    received_at_ms: Mapped[Optional[int]] = mapped_column(
        BigInteger,
        comment="For direction='in': Unix timestamp (ms) when the call was received"
    )
    relative_time_ms: Mapped[Optional[float]] = mapped_column(
        Float,
        comment="Milliseconds since benchmark start"
    )

    # === Context ===
    auth_type: Mapped[Optional[str]] = mapped_column(
        String(30),
        comment="Authentication type used for this call"
    )
    phase_index: Mapped[Optional[int]] = mapped_column(
        SmallInteger,
        comment="Benchmark phase index"
    )
    phase_name: Mapped[Optional[str]] = mapped_column(
        String(100),
        comment="Benchmark phase name"
    )

    experiment: Mapped["Experiment"] = relationship(back_populates="rpc_calls")


class MetricsEcs(Base):
    __tablename__ = "metrics_ecs"
    __table_args__ = (
        Index("idx_ecs_exp", "experiment_id"),
        Index("idx_ecs_exp_svc", "experiment_id", "service_name"),
        Index("idx_ecs_exp_ts", "experiment_id", "timestamp"),
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    experiment_id: Mapped[int] = mapped_column(
        ForeignKey("experiments.id", ondelete="CASCADE"), nullable=False,
        comment="Reference to parent experiment"
    )

    service_name: Mapped[str] = mapped_column(
        String(50), nullable=False,
        comment="ECS service name: 'frontend', 'cart', 'products', etc. For monolith: 'monolith'"
    )
    timestamp: Mapped[datetime] = mapped_column(
        nullable=False,
        comment="Timestamp of this metrics sample"
    )

    cpu_percent: Mapped[Optional[float]] = mapped_column(
        Float,
        comment="Average CPU utilization percentage (0-100) across all tasks in the service"
    )
    memory_percent: Mapped[Optional[float]] = mapped_column(
        Float,
        comment="Average memory utilization percentage (0-100) across all tasks"
    )
    running_tasks: Mapped[Optional[int]] = mapped_column(
        SmallInteger,
        comment="Number of tasks currently running (actual)"
    )
    desired_tasks: Mapped[Optional[int]] = mapped_column(
        SmallInteger,
        comment="Number of tasks desired by auto-scaler (may differ during scaling events)"
    )

    experiment: Mapped["Experiment"] = relationship(back_populates="metrics_ecs")


class MetricsAlb(Base):
    __tablename__ = "metrics_alb"
    __table_args__ = (
        Index("idx_alb_exp", "experiment_id"),
        Index("idx_alb_exp_ts", "experiment_id", "timestamp"),
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    experiment_id: Mapped[int] = mapped_column(
        ForeignKey("experiments.id", ondelete="CASCADE"), nullable=False,
        comment="Reference to parent experiment"
    )

    timestamp: Mapped[datetime] = mapped_column(
        nullable=False,
        comment="Timestamp of this metrics sample"
    )

    request_count: Mapped[Optional[int]] = mapped_column(
        Integer,
        comment="Number of requests processed in this interval"
    )
    response_time_avg: Mapped[Optional[float]] = mapped_column(
        Float,
        comment="Average response time in seconds for this interval"
    )
    response_time_p95: Mapped[Optional[float]] = mapped_column(
        Float,
        comment="95th percentile response time in seconds"
    )

    http_2xx_count: Mapped[Optional[int]] = mapped_column(
        Integer,
        comment="Count of successful responses (200-299)"
    )
    http_4xx_count: Mapped[Optional[int]] = mapped_column(
        Integer,
        comment="Count of client error responses (400-499)"
    )
    http_5xx_count: Mapped[Optional[int]] = mapped_column(
        Integer,
        comment="Count of server error responses (500-599)"
    )

    experiment: Mapped["Experiment"] = relationship(back_populates="metrics_alb")


class EdgeAuthEvent(Base):
    __tablename__ = "edge_auth_events"
    __table_args__ = (
        Index("idx_edge_exp", "experiment_id"),
        Index("idx_edge_exp_event", "experiment_id", "event_type"),
        Index("idx_edge_exp_outcome", "experiment_id", "outcome"),
        Index("idx_edge_exp_instance", "experiment_id", "instance_id"),
        Index("idx_edge_exp_ts", "experiment_id", "timestamp_ms"),
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    experiment_id: Mapped[int] = mapped_column(
        ForeignKey("experiments.id", ondelete="CASCADE"), nullable=False,
        comment="Reference to parent experiment"
    )

    # === Event identification ===
    event_type: Mapped[str] = mapped_column(
        String(30), nullable=False,
        comment="'authCheck' | 'jwksFetch' | 'jwksFetchError' | 'jwksFetchPiggyback' | 'jwksRefetchDebounced'"
    )
    instance_id: Mapped[Optional[str]] = mapped_column(
        String(20),
        comment="Per-execution-environment random ID (12 hex chars). Correlates all events from one warm Lambda@Edge replica."
    )
    lambda_request_id: Mapped[Optional[str]] = mapped_column(
        String(50),
        comment="AWS Lambda Request ID (joins with lambda_executions on edge Lambda)"
    )

    # === Timing ===
    timestamp_ms: Mapped[int] = mapped_column(
        BigInteger, nullable=False,
        comment="Unix timestamp (ms) when the event was emitted (Lambda-side Date.now())"
    )
    relative_time_ms: Mapped[Optional[float]] = mapped_column(
        Float,
        comment="Milliseconds since benchmark start"
    )
    now_perf_ms: Mapped[Optional[float]] = mapped_column(
        Float,
        comment="performance.now() value on the Lambda at emit time. Only meaningful within a single invocation."
    )

    # === authCheck fields ===
    uri: Mapped[Optional[str]] = mapped_column(
        Text,
        comment="authCheck: request URI (path + query)"
    )
    outcome: Mapped[Optional[str]] = mapped_column(
        String(30),
        comment="authCheck: 'success' | 'publicPassthrough' | 'missingToken401' | 'invalidToken401'"
    )
    total_ms: Mapped[Optional[float]] = mapped_column(
        Float,
        comment="authCheck: end-to-end Lambda handler duration (performance.now()-based, excludes cold-start init)"
    )
    key_resolve_ms: Mapped[Optional[float]] = mapped_column(
        Float,
        comment="authCheck success: time spent resolving the Cognito signing key (0 on cache hit, ~1500ms on cold fetch)"
    )
    crypto_verify_ms: Mapped[Optional[float]] = mapped_column(
        Float,
        comment="authCheck success: time spent in crypto.verify() for the Cognito RSA signature"
    )
    sign_ms: Mapped[Optional[float]] = mapped_column(
        Float,
        comment="authCheck success: time spent Ed25519-signing the internal token"
    )
    triggered_jwks_fetch: Mapped[Optional[bool]] = mapped_column(
        Boolean,
        comment="authCheck success: true iff this request caused a JWKS fetch (cold instance or rotation refetch). Used for the three-mode distribution analysis."
    )
    instance_age_ms: Mapped[Optional[int]] = mapped_column(
        BigInteger,
        comment="Milliseconds since this Lambda@Edge replica was booted (0 on cold start, increases on warm invocations)"
    )

    # === jwksFetch / jwksFetchError / jwksFetchPiggyback / jwksRefetchDebounced ===
    trigger: Mapped[Optional[str]] = mapped_column(
        String(20),
        comment="jwksFetch/Piggyback: 'cold' (first fetch on this instance) or 'unknownKid' (rotation refetch)"
    )
    duration_ms: Mapped[Optional[float]] = mapped_column(
        Float,
        comment="jwksFetch(Error): wall-clock time of the HTTPS request to the Cognito JWKS endpoint"
    )
    jwks_fetch_number: Mapped[Optional[int]] = mapped_column(
        Integer,
        comment="jwksFetch: monotonic counter (1 = first fetch on this instance, 2+ = rotation refetches)"
    )
    jwks_key_count: Mapped[Optional[int]] = mapped_column(
        SmallInteger,
        comment="jwksFetch: number of keys returned by Cognito (typically 2)"
    )
    kid: Mapped[Optional[str]] = mapped_column(
        String(100),
        comment="jwksRefetchDebounced: the attacker-or-client-supplied kid that was rejected"
    )
    since_last_ms: Mapped[Optional[int]] = mapped_column(
        BigInteger,
        comment="jwksRefetchDebounced: milliseconds since the previous JWKS fetch (less than JWKS_MIN_REFETCH_INTERVAL_MS = 5000)"
    )
    error: Mapped[Optional[str]] = mapped_column(
        Text,
        comment="jwksFetchError / authCheck(invalidToken401): error message"
    )

    # === Context enrichment (populated during import if possible) ===
    phase_index: Mapped[Optional[int]] = mapped_column(
        SmallInteger,
        comment="Benchmark phase index the event falls into (from timestamp → phase_starts mapping)"
    )
    phase_name: Mapped[Optional[str]] = mapped_column(
        String(100),
        comment="Benchmark phase name"
    )

    experiment: Mapped["Experiment"] = relationship(back_populates="edge_auth_events")

def create_tables(engine):
    """Create all tables in the database."""
    Base.metadata.create_all(engine)


def drop_tables(engine):
    """Drop all tables from the database."""
    Base.metadata.drop_all(engine)
