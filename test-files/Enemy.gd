extends CharacterBody2D
class_name Enemy

@export var health: int = 100
@export var speed: float = 80.0

var target: Node2D = null


func _physics_process(delta: float) -> void:
    if target == null:
        return

    var direction = global_position.direction_to(target.global_position)
    print("[Enemy] direction={direction}")
    var velocity = direction * speed
    print("[Enemy] velocity={velocity}")

    var distance = global_position.distance_to(target.global_position)
    if distance > 500.0:
        print("[Enemy] distance={distance}")

        print("Too far, giving up chase")
        target = null
        return

    velocity = velocity
    move_and_collide(velocity * delta)
