import urllib.request
import urllib.error
import json
import ssl

def check_firestore():
    url = "https://firestore.googleapis.com/v1/projects/loos-77484/databases/(default)/documents/users"
    print(f"Testing Firestore endpoint: {url}")
    ctx = ssl.create_default_context()
    
    req = urllib.request.Request(url, headers={'User-Agent': 'StudyStreakTest/1.0'})
    try:
        with urllib.request.urlopen(req, context=ctx) as response:
            status = response.getcode()
            body = response.read().decode('utf-8')
            print(f"[SUCCESS] HTTP {status}")
            data = json.loads(body)
            print(f"Documents found: {len(data.get('documents', []))}")
            return True
    except urllib.error.HTTPError as e:
        status = e.code
        body = e.read().decode('utf-8')
        print(f"[STATUS {status}]")
        print(f"Response: {body[:300]}")
        return False
    except Exception as ex:
        print(f"[NETWORK ERROR] {ex}")
        return False

if __name__ == "__main__":
    check_firestore()
