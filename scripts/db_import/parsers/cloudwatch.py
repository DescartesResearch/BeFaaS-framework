import csv
import re
from datetime import datetime
from pathlib import Path
from typing import List, Optional
from dataclasses import dataclass


@dataclass
class AlbMetricData:
    """ALB metrics for a single timestamp."""
    timestamp: datetime
    request_count: Optional[int] = None
    response_time_avg: Optional[float] = None
    response_time_p95: Optional[float] = None
    http_2xx_count: Optional[int] = None
    http_4xx_count: Optional[int] = None
    http_5xx_count: Optional[int] = None


@dataclass
class EcsMetricData:
    """ECS metrics for a single service at a single timestamp."""
    timestamp: datetime
    service_name: str
    cpu_percent: Optional[float] = None
    memory_percent: Optional[float] = None
    running_tasks: Optional[int] = None
    desired_tasks: Optional[int] = None


def _parse_timestamp(value: str) -> Optional[datetime]:
    """Parse ISO timestamp from CSV."""
    if not value:
        return None
    try:
        # Handle Z suffix
        value = value.replace('Z', '+00:00')
        return datetime.fromisoformat(value)
    except ValueError:
        return None


def _parse_float(value: str) -> Optional[float]:
    """Parse float value, returning None for empty strings."""
    if not value or value.strip() == '':
        return None
    try:
        return float(value)
    except ValueError:
        return None


def _parse_int(value: str) -> Optional[int]:
    """Parse int value, returning None for empty strings."""
    if not value or value.strip() == '':
        return None
    try:
        return int(float(value))
    except ValueError:
        return None


def parse_alb_metrics(path: Path) -> List[AlbMetricData]:
    """
    Parse alb_metrics.csv file.

    Returns:
        List of AlbMetricData
    """
    if not path.exists():
        return []

    results = []

    try:
        with open(path, 'r', newline='', encoding='utf-8') as f:
            reader = csv.DictReader(f)

            for row in reader:
                timestamp = _parse_timestamp(row.get('timestamp', ''))
                if not timestamp:
                    continue

                results.append(AlbMetricData(
                    timestamp=timestamp,
                    request_count=_parse_int(row.get('ALB Request Count', '')),
                    response_time_avg=_parse_float(row.get('ALB Target Response Time (avg)', '')),
                    response_time_p95=_parse_float(row.get('ALB Target Response Time (p95)', '')),
                    http_2xx_count=_parse_int(row.get('ALB HTTP 2XX Count', '')),
                    http_4xx_count=_parse_int(row.get('ALB HTTP 4XX Count', '')),
                    http_5xx_count=_parse_int(row.get('ALB HTTP 5XX Count', '')),
                ))

    except IOError as e:
        print(f"Error reading ALB metrics: {e}")

    return results


# Regex to extract service name from column header
# Format: "ECS CPU - cart-service" -> "cart-service"
SERVICE_NAME_PATTERN = re.compile(r'ECS (?:CPU|Memory|Running Tasks|Desired Tasks) - (.+)')


def parse_ecs_metrics(path: Path) -> List[EcsMetricData]:
    """
    Parse ecs_metrics.csv file.

    Returns:
        List of EcsMetricData (one per service per timestamp)
    """
    if not path.exists():
        return []

    results = []

    try:
        with open(path, 'r', newline='', encoding='utf-8') as f:
            reader = csv.DictReader(f)

            headers = reader.fieldnames or []
            services = set()
            for header in headers:
                match = SERVICE_NAME_PATTERN.match(header)
                if match:
                    services.add(match.group(1))

            for row in reader:
                timestamp = _parse_timestamp(row.get('timestamp', ''))
                if not timestamp:
                    continue

                for service in services:
                    results.append(EcsMetricData(
                        timestamp=timestamp,
                        service_name=service,
                        cpu_percent=_parse_float(row.get(f'ECS CPU - {service}', '')),
                        memory_percent=_parse_float(row.get(f'ECS Memory - {service}', '')),
                        running_tasks=_parse_int(row.get(f'ECS Running Tasks - {service}', '')),
                        desired_tasks=_parse_int(row.get(f'ECS Desired Tasks - {service}', '')),
                    ))

    except IOError as e:
        print(f"Error reading ECS metrics: {e}")

    return results