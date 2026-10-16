import os
import logging

from label_studio_ml.api import init_app
from model import CSRTVideoTracker

logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"))

app = init_app(model_class=CSRTVideoTracker)

if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="CSRT video tracking ML backend")
    parser.add_argument("-p", "--port", type=int, default=9090)
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--debug", action="store_true")
    args = parser.parse_args()

    app.run(host=args.host, port=args.port, debug=args.debug)
